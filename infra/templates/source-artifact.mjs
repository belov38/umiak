import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	link,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	statfs,
	writeFile,
} from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
export const SOURCES_ARTIFACT_TYPE = "application/vnd.umiak.linux-sources.v1";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const chunkLimit = 512 * 1024 ** 2;
const digestRE = /^[a-f0-9]{64}$/;
async function verifiedCache(receipt, cache, expectedHash, expectedSize) {
	const full = createHash("sha256");
	let total = 0;
	if (
		!Array.isArray(receipt.chunks) ||
		!receipt.chunks.length ||
		receipt.chunks.length > 32
	)
		throw Error("Invalid cached source chunks");
	for (const chunk of receipt.chunks) {
		if (
			!digestRE.test(chunk.sha256) ||
			!Number.isSafeInteger(chunk.sizeBytes) ||
			chunk.sizeBytes <= 0 ||
			chunk.sizeBytes > chunkLimit
		)
			throw Error("Invalid source chunk identity");
		const hash = createHash("sha256");
		let size = 0;
		for await (const b of createReadStream(
			join(cache, "blobs/sha256", chunk.sha256),
		)) {
			hash.update(b);
			full.update(b);
			size += b.length;
		}
		if (size !== chunk.sizeBytes || hash.digest("hex") !== chunk.sha256)
			throw Error("Cached source chunk checksum mismatch");
		total += size;
	}
	if (full.digest("hex") !== expectedHash || total !== expectedSize)
		throw Error("Cached source file checksum mismatch");
}
function allowedRedirect(origin, target) {
	return (
		target.protocol === "https:" &&
		!target.username &&
		!target.password &&
		(!target.port || target.port === "443") &&
		(target.origin === origin.origin ||
			(["github.com", "codeload.github.com"].includes(origin.hostname) &&
				[
					"codeload.github.com",
					"objects.githubusercontent.com",
					"release-assets.githubusercontent.com",
				].includes(target.hostname)))
	);
}
/**
 * GET without transparent decompression. Archive mirrors serve `.diff.gz`
 * files with `Content-Encoding: gzip` (whatever Accept-Encoding says), and
 * fetch() would then hand back the decompressed bytes, which never match the
 * signed size and hash. Corresponding sources must stay byte-for-byte.
 */
export function rawFetch(url, init = {}) {
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: "GET",
				headers: { "accept-encoding": "identity" },
				...(init.signal ? { signal: init.signal } : {}),
			},
			(res) => {
				const headers = new Headers();
				for (const [key, value] of Object.entries(res.headers))
					if (value !== undefined)
						headers.set(key, Array.isArray(value) ? value.join(", ") : value);
				const status = res.statusCode || 0;
				const empty = status === 204 || status === 304;
				if (empty) res.resume();
				resolve(
					new Response(empty ? null : Readable.toWeb(res), { status, headers }),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}
async function sourceResponse(url, fetcher) {
	const origin = new URL(url);
	let current = origin;
	if (origin.protocol !== "https:" || origin.username || origin.password)
		throw Error("Source download requires anonymous HTTPS");
	for (let redirect = 0; redirect < 5; redirect++) {
		const response = await fetcher(current.toString(), {
			redirect: "manual",
			signal: AbortSignal.timeout(2 * 60 * 60_000),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw Error("Source redirect has no location");
			const target = new URL(location, current);
			if (!allowedRedirect(origin, target))
				throw Error("Source redirect escaped approved origins");
			current = target;
			continue;
		}
		return response;
	}
	throw Error("Too many source redirects");
}
/** Original source bytes, split by fixed offsets; unchanged files retain identical OCI blobs. */
export async function captureSourceFile({
	url,
	sha256,
	sizeBytes,
	cache,
	chunkBytes = chunkLimit,
	fetcher = rawFetch,
	wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
	if (
		(sha256 !== undefined && !digestRE.test(sha256)) ||
		(sizeBytes !== undefined &&
			(!Number.isSafeInteger(sizeBytes) ||
				sizeBytes <= 0 ||
				sizeBytes > 8 * 1024 ** 3)) ||
		chunkBytes <= 0 ||
		chunkBytes > chunkLimit
	)
		throw Error("Invalid source file identity");
	await mkdir(join(cache, "blobs/sha256"), { recursive: true });
	const receiptPath = join(cache, `${sha256 || sha(url)}.json`);
	try {
		const old = JSON.parse(await readFile(receiptPath, "utf8"));
		if (sha256 && old.sha256 !== sha256)
			throw Error("Cached source identity changed");
		await verifiedCache(
			old,
			cache,
			sha256 || old.sha256,
			sizeBytes || old.sizeBytes,
		);
		return { ...old, url };
	} catch (error) {
		if (error.code !== "ENOENT") await rm(receiptPath, { force: true });
	}
	const fs = await statfs(cache);
	if (
		Number(fs.bavail) * Number(fs.bsize) <
		(sizeBytes || 1024 ** 3) + 2 * 1024 ** 3
	)
		throw Error(
			"Insufficient disk for corresponding sources; use a runner with more disk",
		);
	let last;
	for (let attempt = 0; attempt < 5; attempt++) {
		let part,
			file,
			partHash,
			partSize = 0;
		const chunks = [];
		const full = createHash("sha256");
		let total = 0;
		const finish = async () => {
			if (!file) return;
			await file.sync();
			await file.close();
			file = undefined;
			const hash = partHash.digest("hex");
			await rename(part, join(cache, "blobs/sha256", hash));
			part = undefined;
			chunks.push({ sha256: hash, sizeBytes: partSize });
			partSize = 0;
		};
		try {
			const response = await sourceResponse(url, fetcher);
			if (!response.ok) throw Error(`Source download HTTP ${response.status}`);
			for await (const data of response.body) {
				full.update(data);
				total += data.length;
				if (total > (sizeBytes || 8 * 1024 ** 3))
					throw Error("Source size exceeds pinned limit");
				let offset = 0;
				while (offset < data.length) {
					if (!file) {
						part = join(cache, `.source-${randomUUID()}`);
						file = await open(part, "wx", 0o600);
						partHash = createHash("sha256");
					}
					const piece = data.subarray(
						offset,
						offset + Math.min(chunkBytes - partSize, data.length - offset),
					);
					// FileHandle.write may be partial; writeFile appends the whole slice at its current offset.
					await file.writeFile(piece);
					partHash.update(piece);
					partSize += piece.length;
					offset += piece.length;
					if (partSize === chunkBytes) await finish();
				}
			}
			await finish();
			const actual = full.digest("hex");
			if (
				!total ||
				(sha256 && actual !== sha256) ||
				(sizeBytes && total !== sizeBytes)
			)
				throw Error("Source file checksum/size mismatch");
			const result = { url, sha256: actual, sizeBytes: total, chunks };
			await writeFile(receiptPath, JSON.stringify(result));
			return result;
		} catch (error) {
			last = error;
			if (/checksum|size exceeds/.test(error.message)) throw error;
			if (attempt < 4) await wait(Math.min(60000, 2000 * 2 ** attempt));
		} finally {
			await file?.close();
			if (part) await rm(part, { force: true });
		}
	}
	throw last;
}
export async function writeSourceLayout({
	directory,
	cache,
	version,
	slug,
	sourceCommit,
	files,
	mapping,
}) {
	if (
		!["linux", "linux-desktop"].includes(slug) ||
		!files.length ||
		files.length > 8192 ||
		!mapping.length
	)
		throw Error("Incomplete corresponding-source companion");
	const known = new Set(files.map((f) => f.path));
	for (const binary of mapping)
		if (
			!digestRE.test(binary.binarySha256) ||
			!binary.sources?.length ||
			binary.sources.some((path) => !known.has(path))
		)
			throw Error("Binary source mapping is incomplete");
	const body = Buffer.from(
		JSON.stringify({
			format: "umiak-linux-sources/v1",
			version,
			slug,
			sourceCommit,
			files,
			mapping,
		}),
	);
	if (body.length > 8 * 1024 ** 2) throw Error("Source metadata exceeds limit");
	await mkdir(join(directory, "blobs/sha256"), { recursive: true });
	const put = async (bytes) => {
		const hash = sha(bytes);
		await writeFile(join(directory, "blobs/sha256", hash), bytes);
		return { digest: `sha256:${hash}`, size: bytes.length };
	};
	const layers = [
		{
			mediaType: "application/vnd.umiak.source-manifest.v1+json",
			...(await put(body)),
			annotations: { "org.opencontainers.image.title": "source-manifest.json" },
		},
	];
	const chunks = new Map();
	for (const file of files)
		for (const chunk of file.chunks) chunks.set(chunk.sha256, chunk.sizeBytes);
	if (chunks.size > 8192)
		throw Error("Source companion chunk count exceeds limit");
	for (const [hash, size] of [...chunks].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		await link(
			join(cache, "blobs/sha256", hash),
			join(directory, "blobs/sha256", hash),
		);
		layers.push({
			mediaType: "application/vnd.umiak.source.chunk.v1",
			digest: `sha256:${hash}`,
			size,
			annotations: { "org.opencontainers.image.title": `source-${hash}` },
		});
	}
	const config = {
		mediaType: "application/vnd.oci.empty.v1+json",
		...(await put(Buffer.from("{}"))),
	};
	const manifest = Buffer.from(
		JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			artifactType: SOURCES_ARTIFACT_TYPE,
			config,
			layers,
			annotations: {
				"org.opencontainers.image.source": "https://github.com/belov38/umiak",
				"org.opencontainers.image.version": version,
			},
		}),
	);
	const descriptor = {
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		...(await put(manifest)),
		annotations: { "org.opencontainers.image.ref.name": version },
	};
	await writeFile(
		join(directory, "oci-layout"),
		'{"imageLayoutVersion":"1.0.0"}',
	);
	await writeFile(
		join(directory, "index.json"),
		JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
	);
	return {
		repository:
			slug === "linux"
				? "belov38/umiak-linux-layer-sources"
				: "belov38/umiak-linux-desktop-layer-sources",
		digest: descriptor.digest,
		bytes: [...chunks.values()].reduce((a, b) => a + b, 0),
		files: files.length,
		chunks: chunks.size,
	};
}

import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Versions } from "./recipe.ts";

export const DEBIAN_CLOUD = "https://cloud.debian.org/images/cloud/trixie/";
export function debianImageUrl(serial: string): string {
	if (!/^\d{8}-\d+$/.test(serial))
		throw new Error("invalid Debian cloud serial");
	return `${DEBIAN_CLOUD}${serial}/debian-13-genericcloud-amd64-${serial}.qcow2`;
}

/** No redirects: TLS trust at pin time is restricted to this exact Debian host. */
export async function debianFetch(url: string): Promise<Response> {
	const u = new URL(url);
	if (
		u.protocol !== "https:" ||
		u.host !== "cloud.debian.org" ||
		u.username ||
		u.password
	)
		throw new Error("Debian source must use HTTPS on cloud.debian.org");
	const r = await fetch(url, {
		redirect: "error",
		signal: AbortSignal.timeout(60_000),
		headers: { "User-Agent": "umiak-tpl" },
	});
	if (r.status !== 200) throw new Error(`GET ${url}: HTTP ${r.status}`);
	return r;
}

/** Only image bytes may follow redirects; their integrity comes from the checksum pins. */
export async function debianImageFetch(url: string): Promise<Response> {
	for (let redirects = 0; redirects <= 5; redirects++) {
		const u = new URL(url);
		if (u.protocol !== "https:" || u.username || u.password)
			throw new Error("Debian image redirect must use HTTPS");
		const r = await fetch(url, {
			redirect: "manual",
			headers: { "User-Agent": "umiak-tpl" },
		});
		if ([301, 302, 303, 307, 308].includes(r.status)) {
			const location = r.headers.get("location");
			await r.body?.cancel();
			if (!location) throw new Error("Debian image redirect has no Location");
			url = new URL(location, url).href;
			continue;
		}
		if (r.status !== 200) throw new Error(`GET ${url}: HTTP ${r.status}`);
		return r;
	}
	throw new Error("Debian image: too many redirects");
}

export function debianChecksum(text: string, name: string): string {
	for (const line of text.split("\n")) {
		const m = /^([a-f0-9]{128})\s+\*?(\S+)$/.exec(line);
		if (m?.[2] === name && m[1]) return m[1];
	}
	throw new Error(`SHA512SUMS: missing ${name}`);
}

async function hashes(
	source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; sha512: string }> {
	const a = createHash("sha256"),
		b = createHash("sha512");
	for await (const chunk of source) {
		a.update(chunk);
		b.update(chunk);
	}
	return { sha256: a.digest("hex"), sha512: b.digest("hex") };
}

export async function resolveDebianBase(): Promise<Versions["base"]> {
	const listing = await (await debianFetch(DEBIAN_CLOUD)).text();
	const serial = [...listing.matchAll(/href="(\d{8}-\d+)\/"/g)]
		.map((m) => m[1] as string)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.at(-1);
	if (!serial) throw new Error("Debian cloud: no serial directories");
	const url = debianImageUrl(serial);
	const sums = await (
		await debianFetch(`${DEBIAN_CLOUD}${serial}/SHA512SUMS`)
	).text();
	const sha512 = debianChecksum(sums, url.split("/").at(-1) as string);
	const r = await debianImageFetch(url);
	if (!r.body) throw new Error("Debian image: empty body");
	const got = await hashes(r.body);
	if (got.sha512 !== sha512)
		throw new Error("Debian image: SHA512SUMS mismatch at pin time");
	return { serial, url, ...got };
}

/** Signed Umiak pins are the build trust anchor; check both hashes, even for cached images. */
export async function fetchDebianImage(o: {
	cacheDir: string;
	base: Versions["base"];
}): Promise<{ path: string; sha256: string }> {
	const { base } = o;
	const url = debianImageUrl(base.serial);
	if (base.url !== url || !base.sha512)
		throw new Error("Debian base requires canonical source URL and SHA512 pin");
	const dir = join(o.cacheDir, `debian-${base.serial}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, url.split("/").at(-1) as string);
	const matches = (v: { sha256: string; sha512: string }) =>
		v.sha256 === base.sha256 && v.sha512 === base.sha512;
	if (existsSync(path) && matches(await hashes(createReadStream(path))))
		return { path, sha256: base.sha256 };
	const part = `${path}.part`;
	try {
		const r = await debianImageFetch(url);
		if (!r.body) throw new Error("Debian image: empty body");
		await pipeline(r.body, createWriteStream(part));
		if (!matches(await hashes(createReadStream(part))))
			throw new Error("Debian image: pinned SHA256/SHA512 mismatch");
		renameSync(part, path);
		return { path, sha256: base.sha256 };
	} finally {
		rmSync(part, { force: true });
	}
}

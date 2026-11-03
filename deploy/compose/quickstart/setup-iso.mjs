// Media bytes flow directly from the owner's source to PVE, never through Umiak.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const VIRTIO_STABLE_URL =
	"https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.271-1/virtio-win-0.1.271.iso";
// Immutable archive version matches the recipe checksum.
export const VIRTIO_SHA256 =
	"bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429";
const HASH = /^[a-f0-9]{64}$/i;
const FILE = /^[a-zA-Z0-9._()+-]+\.iso$/i;
function publicAddress(address) {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19))
		);
	}
	// Only global unicast IPv6 is eligible; this also rejects mapped private IPv4.
	return (
		isIP(address) === 6 &&
		/^[23][0-9a-f]{3}:/i.test(address) &&
		!/^2001:db8:/i.test(address) &&
		!/^2002:/i.test(address) &&
		!/^2001:(?:0{1,4}:|:)/i.test(address)
	);
}
export async function validateMediaUrl(
	value,
	sha256,
	{ allowInternal = false, resolve = lookup } = {},
) {
	if (sha256 && !HASH.test(sha256))
		throw Error("SHA256 must contain 64 hexadecimal characters when supplied");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		throw Error("ISO URL must use HTTPS without credentials or a fragment");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!allowInternal) {
		if (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local")
		)
			throw Error(
				"ISO URL targets an internal address; explicitly allow internal URLs to continue",
			);
		const addresses = isIP(host)
			? [{ address: host }]
			: await resolve(host, { all: true });
		if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
			throw Error(
				"ISO URL resolves to an internal or loopback address; explicitly allow internal URLs to continue",
			);
	}
	return url.href;
}
export function validateUploadedIso(value) {
	return (
		typeof value === "string" &&
		/^(?:[A-Za-z0-9_-]+:iso\/)?[a-zA-Z0-9._()+-]+\.iso$/i.test(value)
	);
}
// Audit wget's GET path separately from the advisory HEAD preflight.
export async function auditDownloadLog(lines, initialUrl, options = {}) {
	let url = initialUrl;
	const proxy = options.proxy ? new URL(options.proxy) : null;
	const proxyHost = proxy?.hostname.replace(/^\[|\]$/g, "");
	const proxyPort =
		proxy?.port || (proxy?.protocol === "https:" ? "443" : "80");
	for (const line of lines) {
		const text = String(line.t || "");
		const location = text.match(/Location:\s*(.*?)\s*(?:\[following\])?$/i);
		if (location) {
			url = new URL(location[1], url).href;
			await validateMediaUrl(url, undefined, options);
		}
		// Only the cluster-configured proxy transport is exempt, never redirect targets.
		const resolvedHost = text.match(/Resolving ([^\s]+) \(/i)?.[1];
		const connected =
			text.match(/Connecting to ([^\s]+)(?: \([^)]*\))?\|[^|]+\|:(\d+)/i) ||
			text.match(/Connecting to (\[[^\]]+\]|[0-9.]+):(\d+)/i);
		if (
			proxyHost &&
			(resolvedHost === proxyHost ||
				(connected &&
					connected[1].replace(/^\[|\]$/g, "") === proxyHost &&
					connected[2] === proxyPort))
		)
			continue;
		const resolving = text.match(/Resolving .*?\)\.\.\.\s*(.*)/i);
		const connecting =
			text.match(/Connecting to .*?\|([^|]+)\|/i) ||
			text.match(/Connecting to (\[[^\]]+\]|[0-9.]+):\d+/i);
		const addresses = resolving
			? resolving[1].split(/[,\s]+/).filter(Boolean)
			: connecting
				? [connecting[1]]
				: [];
		for (const raw of addresses) {
			if (raw === "...") continue;
			const address = raw.replace(/\.\.\.$/, "").replace(/^\[|\]$/g, "");
			if (!isIP(address)) throw Error("Unrecognized wget address in task log");
			await validateMediaUrl(
				`https://${isIP(address) === 6 ? `[${address}]` : address}/`,
				undefined,
				options,
			);
		}
	}
}
export async function validateWindowsMedia(input, options = {}) {
	if (input.isoUrl)
		await validateMediaUrl(input.isoUrl, input.isoSha256, {
			...options,
			allowInternal: input.allowInternalIsoUrls === true,
		});
	else if (
		!validateUploadedIso(input.iso) ||
		(input.isoSha256 && !HASH.test(input.isoSha256))
	)
		throw Error("Supply an uploaded ISO file name or HTTPS URL and its SHA256");
	if (input.virtioUrl)
		await validateMediaUrl(input.virtioUrl, input.virtioSha256, {
			...options,
			allowInternal: input.allowInternalIsoUrls === true,
		});
	if (
		input.virtioIso &&
		(!validateUploadedIso(input.virtioIso) ||
			(input.virtioSha256 && !HASH.test(input.virtioSha256)))
	)
		throw Error("VirtIO ISO needs a file name and SHA256");
}
export function downloadPermission(permissions, node, storage) {
	const at = (path, priv) =>
		Boolean(permissions[path]?.[priv] || permissions["/"]?.[priv]);
	return (
		at(`/storage/${storage}`, "Datastore.AllocateTemplate") &&
		(at(`/nodes/${node}`, "Sys.AccessNetwork") ||
			(at("/", "Sys.Modify") && at("/", "Sys.Audit")))
	);
}
export async function prepareWindowsMedia(
	api,
	node,
	input,
	{
		resolve = lookup,
		checksum,
		head = async (url) =>
			fetch(url, {
				method: "HEAD",
				redirect: "manual",
				signal: AbortSignal.timeout(15000),
			}),
		progress = async () => {},
		pause = () => new Promise((r) => setTimeout(r, 1000)),
		timeoutMs = 2 * 60 * 60 * 1000,
	} = {},
) {
	await validateWindowsMedia(input, { resolve });
	const storages = await api.get(`/nodes/${node}/storage`);
	const eligible = storages.filter(
		(x) =>
			String(x.content || "")
				.split(",")
				.includes("iso") &&
			Number(x.active ?? 1) !== 0 &&
			Number(x.enabled ?? 1) !== 0,
	);
	const uploadedStorage =
		!input.isoUrl && input.iso?.includes(":iso/")
			? input.iso.split(":iso/")[0]
			: undefined;
	const storage = uploadedStorage || input.mediaStorage || eligible[0]?.storage;
	if (
		input.virtioIso?.includes(":iso/") &&
		input.virtioIso.split(":iso/")[0] !== storage
	)
		throw Error("Windows and VirtIO ISO volumes must use the same storage");
	if (!eligible.some((x) => x.storage === storage))
		throw Error("Choose an active PVE storage with iso content");
	const permissions = await api.get("/access/permissions");
	if (
		(input.isoUrl || input.virtioUrl) &&
		!downloadPermission(permissions, node, storage)
	)
		throw Error(
			`ISO downloads require Datastore.AllocateTemplate on /storage/${storage} and Sys.AccessNetwork on /nodes/${node}; ask the host administrator to grant this scoped permission`,
		);
	const clusterOptions =
		input.isoUrl || input.virtioUrl ? await api.get("/cluster/options") : {};
	const files = await api.get(`/nodes/${node}/storage/${storage}/content`);
	const ensure = async (kind, url, hash, existing) => {
		let metadata;
		if (url) {
			for (let redirects = 0; redirects <= 5; redirects++) {
				await validateMediaUrl(url, hash, {
					resolve,
					allowInternal: input.allowInternalIsoUrls === true,
				});
				try {
					metadata = await head(url);
				} catch {
					await progress(
						"ISO HEAD metadata unavailable; PVE GET task log will be audited",
					);
					break;
				}
				if (metadata.status >= 300 && metadata.status < 400) {
					const next = new URL(metadata.headers.get("location"), url);
					// Fedora's stable alias emits an HTTP Location on the same host. Keep transport HTTPS.
					if (next.protocol === "http:" && next.host === new URL(url).host)
						next.protocol = "https:";
					url = next.href;
					if (redirects === 5) throw Error("Too many ISO URL redirects");
					continue;
				}
				if (!metadata.ok)
					await progress(
						`ISO HEAD metadata returned HTTP ${metadata.status}; PVE GET task log will be audited`,
					);
				break;
			}
		}

		const verified = Boolean(hash);
		if (!verified)
			await progress("Not verified: the ISO will be used as downloaded");
		const sourceName = url
			? decodeURIComponent(new URL(url).pathname.split("/").pop())
			: existing.replace(/^[A-Za-z0-9_-]+:iso\//, "");
		const name = url && hash ? `${kind}-${hash.toLowerCase()}.iso` : sourceName;
		if (!FILE.test(name) || name.startsWith("umiak-"))
			throw Error("ISO URL must end in a plain .iso file name");
		const volume = `${storage}:iso/${name}`;
		const found = files.find((x) => x.volid === volume);
		if (found) {
			if (!hash && url) {
				const response = metadata;
				const size = Number(response?.headers.get("content-length"));
				if (!response?.ok || !size || size !== Number(found.size))
					throw Error(
						"Existing unverified ISO size differs or cannot be checked; choose a new filename or provide SHA256",
					);
			}
			if (!checksum)
				throw Error(
					"Existing ISO checksum verification requires the restricted node-agent",
				);
			const actual = (await checksum(name, storage)).toLowerCase();
			if (hash && actual !== hash.toLowerCase())
				throw Error(
					`Existing ${kind} ISO checksum mismatch; the file was not overwritten`,
				);
			await progress(
				`Reusing ${verified ? "verified" : "unverified"} ${volume}`,
			);
			return {
				name,
				sha256: actual,
				verification: verified ? "verified" : "unverified",
			};
		}
		if (!url) throw Error(`Uploaded ISO ${volume} not found`);
		const task = await api.post(
			`/nodes/${node}/storage/${storage}/download-url`,
			{
				content: "iso",
				url,
				filename: name,
				...(hash
					? { checksum: hash.toLowerCase(), "checksum-algorithm": "sha256" }
					: {}),
				"verify-certificates": 1,
			},
		);
		await progress(
			`Downloading ${kind} ISO directly to ${storage}; PVE task ${task}`,
		);
		const path = `/nodes/${node}/tasks/${encodeURIComponent(task)}`;
		const deadline = Date.now() + timeoutMs;
		let seen = 0;
		while (Date.now() < deadline) {
			const logs = await api.get(`${path}/log`);
			for (const line of logs.slice(seen)) await progress(String(line.t || ""));
			seen = logs.length;
			const status = await api.get(`${path}/status`);
			if (status.status === "stopped") {
				try {
					// PVE task logs paginate; re-read every page after completion, including final lines.
					const completeLog = [];
					for (let start = 0; ; ) {
						const page = await api.get(`${path}/log?start=${start}&limit=500`);
						completeLog.push(...page);
						if (page.length < 500) break;
						start += page.length;
					}
					await auditDownloadLog(completeLog, url, {
						resolve,
						proxy: clusterOptions.http_proxy,
						allowInternal: input.allowInternalIsoUrls === true,
					});
				} catch (error) {
					try {
						await api.delete(
							`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volume)}`,
						);
					} catch (cleanup) {
						throw Error(
							`ISO download audit rejected: ${error.message}; deletion failed: ${cleanup.message}. Remove ${volume} before retrying`,
						);
					}
					throw Error(
						`ISO download audit rejected: ${error.message}; deleted ${volume}`,
					);
				}
				if (status.exitstatus !== "OK")
					throw Error(
						`PVE ${kind} ISO download failed: ${status.exitstatus}; inspect the download task log`,
					);
				const actual =
					hash?.toLowerCase() ||
					(checksum
						? (await checksum(name, storage)).toLowerCase()
						: undefined);
				if (actual)
					await progress(
						`${kind} downloaded SHA256: ${actual}${verified ? "" : " (recorded, source not verified)"}`,
					);
				return {
					name,
					sha256: actual,
					verification: verified ? "verified" : "unverified",
				};
			}
			await pause();
		}
		throw Error(
			`PVE ${kind} ISO download is still running; inspect task ${task} before retrying`,
		);
	};
	const iso = await ensure("windows", input.isoUrl, input.isoSha256, input.iso);
	const virtioIso =
		input.virtioUrl || input.virtioIso
			? await ensure(
					"virtio",
					input.virtioUrl,
					input.virtioSha256,
					input.virtioIso,
				)
			: undefined;
	return {
		...input,
		iso: iso.name,
		isoSha256: iso.sha256,
		virtioIso: virtioIso?.name,
		virtioSha256: virtioIso?.sha256,
		mediaVerification:
			iso.verification === "unverified" ||
			virtioIso?.verification === "unverified"
				? "unverified"
				: "verified",
		mediaStorage: storage,
	};
}

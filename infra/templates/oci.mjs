import { createHash } from "node:crypto";
export const OCI_REGISTRY = "https://ghcr.io";
export const LAYER_ARTIFACT_TYPE = "application/vnd.umiak.linux-layer.v1";
export const OCI_SOURCE_REPOSITORIES = Object.freeze({
	linux: "belov38/umiak-linux-layer-sources",
	"linux-desktop": "belov38/umiak-linux-desktop-layer-sources",
});
export const OCI_REPOSITORIES = Object.freeze({
	linux: "belov38/umiak-linux-layer",
	"linux-desktop": "belov38/umiak-linux-desktop-layer",
});
const digest = /^[a-f0-9]{64}$/;
export function ociRedirectAllowed(registry, target) {
	const origin = new URL(registry),
		url = new URL(target);
	return (
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		(url.origin === origin.origin ||
			(origin.hostname === "ghcr.io" &&
				url.hostname === "pkg-containers.githubusercontent.com" &&
				(!url.port || url.port === "443")))
	);
}
async function bounded(response, max) {
	if (!response.body) throw Error("OCI response has no body");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > max) throw Error("OCI response exceeds size limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
/** Tokens are anonymous, pull-only, in memory, and never forwarded to the blob CDN. */
export class AnonymousOCI {
	constructor({
		registry = OCI_REGISTRY,
		repository,
		fetcher = fetch,
		artifactType = LAYER_ARTIFACT_TYPE,
		maxLayers = 520,
		maxManifestBytes = 1024 ** 2,
		wait = (ms) => new Promise((r) => setTimeout(r, ms)),
	}) {
		const url = new URL(registry);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!["", "/"].includes(url.pathname) ||
			typeof repository !== "string" ||
			repository.length > 255 ||
			!/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/.test(
				repository,
			)
		)
			throw Error("Invalid OCI registry/repository configuration");
		this.artifactType = artifactType;
		this.maxLayers = maxLayers;
		this.maxManifestBytes = maxManifestBytes;
		this.origin = url.origin;
		this.repository = repository;
		this.fetcher = fetcher;
		this.wait = wait;
	}
	async authenticate(challenge) {
		if (!/^Bearer /i.test(challenge || ""))
			throw Error(
				"OCI package must allow anonymous pulls; set its visibility to Public",
			);
		const fields = {};
		for (const m of challenge.matchAll(/([a-z_]+)="([^"\r\n]*)"/gi)) {
			if (Object.hasOwn(fields, m[1].toLowerCase()))
				throw Error("Invalid OCI auth challenge");
			fields[m[1].toLowerCase()] = m[2];
		}
		const realm = new URL(fields.realm || "invalid:");
		if (
			realm.protocol !== "https:" ||
			realm.origin !== this.origin ||
			realm.username ||
			realm.password ||
			realm.hash
		)
			throw Error("OCI auth realm escaped its configured origin");
		const scope = `repository:${this.repository}:pull`;
		if (fields.scope && fields.scope !== scope)
			throw Error("OCI auth challenge requested a different scope");
		realm.searchParams.set(
			"service",
			fields.service || new URL(this.origin).host,
		);
		realm.searchParams.set("scope", scope);
		let response;
		try {
			response = await this.fetcher(realm.toString(), {
				redirect: "manual",
				signal: AbortSignal.timeout(60000),
				headers: { Accept: "application/json" },
			});
		} catch {
			throw Error("OCI anonymous token request failed");
		}
		if (!response.ok)
			throw Error(
				`OCI anonymous pull denied (HTTP ${response.status}); set the package to Public`,
			);
		let data;
		try {
			data = JSON.parse((await bounded(response, 32768)).toString());
		} catch {
			throw Error("Invalid OCI anonymous token response");
		}
		const token = data.token || data.access_token;
		if (
			typeof token !== "string" ||
			token.length > 16384 ||
			!/^[A-Za-z0-9._~+/-]+=*$/.test(token)
		)
			throw Error("Invalid OCI anonymous token response");
		this.token = token;
		this.expires =
			Date.now() +
			(Math.max(30, Math.min(3600, Number(data.expires_in) || 300)) - 10) *
				1000;
	}
	async request(path, max, expectedDigest) {
		let last;
		for (let attempt = 0; attempt < 5; attempt++) {
			let retryDelay = Math.min(30000, 1000 * 2 ** attempt);
			let url = `${this.origin}/v2/${this.repository}/${path}`,
				authenticated = false,
				redirects = 0;
			for (let step = 0; step < 8; step++) {
				const headers = {
					Accept: path.startsWith("manifests/")
						? "application/vnd.oci.image.manifest.v1+json"
						: "application/octet-stream",
				};
				if (
					new URL(url).origin === this.origin &&
					this.token &&
					Date.now() < this.expires
				)
					headers.Authorization = `Bearer ${this.token}`;
				let response;
				try {
					response = await this.fetcher(url, {
						redirect: "manual",
						signal: AbortSignal.timeout(60000),
						headers,
					});
				} catch {
					last = Error("OCI registry request failed");
					break;
				}
				if (
					response.status === 401 &&
					new URL(url).origin === this.origin &&
					!authenticated
				) {
					const challenge = response.headers.get("www-authenticate");
					await response.body?.cancel();
					await this.authenticate(challenge);
					authenticated = true;
					continue;
				}
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					const location = response.headers.get("location");
					await response.body?.cancel();
					if (!location || ++redirects > 4)
						throw Error("Invalid OCI blob redirect");
					const target = new URL(location, url);
					if (!ociRedirectAllowed(this.origin, target))
						throw Error("OCI blob redirect escaped its allowed origin");
					url = target.toString();
					continue;
				}
				if (response.status === 429 || response.status >= 500) {
					const after = response.headers.get("retry-after");
					const delay =
						after && /^\d+$/.test(after)
							? Number(after) * 1000
							: Date.parse(after || "") - Date.now();
					if (Number.isFinite(delay) && delay > 0)
						retryDelay = Math.min(60000, Math.max(retryDelay, delay));
					await response.body?.cancel();
					last = Error(`OCI registry HTTP ${response.status}`);
					break;
				}
				if (!response.ok) {
					await response.body?.cancel();
					const error = Error(
						`OCI artifact not available (HTTP ${response.status}); package must be Public and channel published`,
					);
					error.status = response.status;
					throw error;
				}
				const bytes = await bounded(response, max);
				if (
					expectedDigest &&
					createHash("sha256").update(bytes).digest("hex") !== expectedDigest
				)
					throw Error("OCI blob digest mismatch");
				return bytes;
			}
			if (attempt < 4) await this.wait(retryDelay);
		}
		throw last || Error("OCI registry request failed after five attempts");
	}
	async blob(sha256, sizeBytes) {
		if (
			!digest.test(sha256) ||
			!Number.isSafeInteger(sizeBytes) ||
			sizeBytes < 0 ||
			sizeBytes > 512 * 1024 ** 2
		)
			throw Error("Invalid OCI blob descriptor");
		const bytes = await this.request(
			`blobs/sha256:${sha256}`,
			sizeBytes,
			sha256,
		);
		if (bytes.length !== sizeBytes) throw Error("OCI blob size mismatch");
		return bytes;
	}
	async manifest(tag) {
		if (
			!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[a-f0-9]{64})$/.test(tag)
		)
			throw Error("Invalid OCI artifact tag");
		const bytes = await this.request(
			`manifests/${tag}`,
			this.maxManifestBytes,
			tag.startsWith("sha256:") ? tag.slice(7) : undefined,
		);
		let manifest;
		try {
			manifest = JSON.parse(bytes.toString());
		} catch {
			throw Error("Invalid OCI manifest JSON");
		}
		if (
			manifest.schemaVersion !== 2 ||
			manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
			manifest.artifactType !== this.artifactType ||
			!Array.isArray(manifest.layers) ||
			manifest.layers.length > this.maxLayers
		)
			throw Error("Not a Umiak Linux layer OCI artifact");
		const titles = new Set();
		for (const layer of manifest.layers) {
			const title = layer.annotations?.["org.opencontainers.image.title"];
			if (
				!/^sha256:[a-f0-9]{64}$/.test(layer.digest) ||
				!Number.isSafeInteger(layer.size) ||
				layer.size <= 0 ||
				layer.size > 512 * 1024 ** 2 ||
				typeof title !== "string" ||
				title.length > 512 ||
				titles.has(title)
			)
				throw Error("Invalid OCI layer descriptor");
			titles.add(title);
		}
		return manifest;
	}
}

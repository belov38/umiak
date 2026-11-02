// Paths and rules of the Files tab (S8 §9.6), without the DOM. Paths in
// the tab are absolute guest paths (POSIX); the home directory is read
// once with `stat ~`.
import { API_BASE_URL } from "@/lib/api-base";

/** Text preview limit: `Range: bytes=0-1048575` (S8 §9.6). */
export const PREVIEW_MAX_BYTES = 1024 * 1024;
/** Up to this size a file is sent with one `PUT /files/content`. */
export const SINGLE_PUT_MAX_BYTES = 64 * 1024 * 1024;

/** An absolute path without `.`, `..`, empty or trailing parts. */
export function normalizePath(p: string): string {
	const out: string[] = [];
	for (const part of p.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

export function parentPath(p: string): string {
	return normalizePath(`${p}/..`);
}

export function joinPath(dir: string, name: string): string {
	return normalizePath(`${dir}/${name}`);
}

export interface Crumb {
	name: string;
	path: string;
}

/** `/`, then one crumb per directory down to `p`. */
export function breadcrumbs(p: string): Crumb[] {
	const crumbs: Crumb[] = [{ name: "/", path: "/" }];
	let at = "";
	for (const part of normalizePath(p).split("/")) {
		if (part === "") continue;
		at = `${at}/${part}`;
		crumbs.push({ name: part, path: at });
	}
	return crumbs;
}

export function isHidden(name: string): boolean {
	return name.startsWith(".");
}

/**
 * Link that downloads a file (S7 answers with `Content-Disposition:
 * attachment`). A link carries no `Umiak-Team` header, so the team goes in
 * the query (S8 §9.2, C4).
 */
export function fileDownloadUrl(o: {
	sandboxId: string;
	path: string;
	teamId: string;
}): string {
	return (
		`${API_BASE_URL}/v1/sandboxes/${encodeURIComponent(o.sandboxId)}/files/content` +
		`?path=${encodeURIComponent(o.path)}&team=${encodeURIComponent(o.teamId)}`
	);
}

/** A file small enough for the text preview. */
export function previewable(f: { type: string; sizeBytes: number }): boolean {
	return f.type === "file" && f.sizeBytes <= PREVIEW_MAX_BYTES;
}

/** The bytes as text, or null when they look binary (NUL, not UTF-8). */
export function decodePreview(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return null;
	}
}

/** One PUT up to 64 MiB; larger files go in resumable chunks (S7 §11.1). */
export function uploadStrategy(sizeBytes: number): "put" | "chunked" {
	return sizeBytes <= SINGLE_PUT_MAX_BYTES ? "put" : "chunked";
}

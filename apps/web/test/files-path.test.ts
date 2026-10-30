// Paths of the Files tab (S8 §9.6): breadcrumbs, `..`, the download link
// with `?team=` (S8 §9.2), text preview and the upload strategy.
import { describe, expect, it } from "vitest";
import {
	breadcrumbs,
	decodePreview,
	fileDownloadUrl,
	isHidden,
	joinPath,
	normalizePath,
	PREVIEW_MAX_BYTES,
	parentPath,
	previewable,
	SINGLE_PUT_MAX_BYTES,
	uploadStrategy,
} from "@/features/sandbox/files-path";

describe("paths", () => {
	it("normalizes slashes, `.` and `..`", () => {
		expect(normalizePath("/home/user/")).toBe("/home/user");
		expect(normalizePath("//home//user/./src/../app")).toBe("/home/user/app");
		expect(normalizePath("/..")).toBe("/");
		expect(normalizePath("")).toBe("/");
		expect(normalizePath("/")).toBe("/");
	});

	it("`..` goes one level up and stops at the root", () => {
		expect(parentPath("/home/user/my-app")).toBe("/home/user");
		expect(parentPath("/home")).toBe("/");
		expect(parentPath("/")).toBe("/");
	});

	it("joins a directory and a name", () => {
		expect(joinPath("/home/user", "a.txt")).toBe("/home/user/a.txt");
		expect(joinPath("/", "etc")).toBe("/etc");
		expect(joinPath("/home/user", "../x")).toBe("/home/x");
	});

	it("breadcrumbs from the root to the directory", () => {
		expect(breadcrumbs("/home/user/my app")).toEqual([
			{ name: "/", path: "/" },
			{ name: "home", path: "/home" },
			{ name: "user", path: "/home/user" },
			{ name: "my app", path: "/home/user/my app" },
		]);
		expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
	});

	it("hidden files start with a dot", () => {
		expect(isHidden(".env")).toBe(true);
		expect(isHidden("env")).toBe(false);
	});
});

describe("download link", () => {
	it("encodes the path and adds the team (browsers set no header on a link)", () => {
		const url = fileDownloadUrl({
			sandboxId: "sb_1",
			path: "/home/user/a b&c=d#e?.txt",
			teamId: "team_1",
		});
		expect(url).toBe(
			"/api/v1/sandboxes/sb_1/files/content?path=%2Fhome%2Fuser%2Fa%20b%26c%3Dd%23e%3F.txt&team=team_1",
		);
		const q = new URL(url, "https://app.example.test").searchParams;
		expect(q.get("path")).toBe("/home/user/a b&c=d#e?.txt");
		expect(q.get("team")).toBe("team_1");
	});

	it("encodes the sandbox reference too", () => {
		expect(
			fileDownloadUrl({ sandboxId: "a/b", path: "/x", teamId: "team_1" }),
		).toMatch(/^\/api\/v1\/sandboxes\/a%2Fb\/files\/content\?/);
	});
});

describe("preview", () => {
	it("only files up to 1 MiB", () => {
		expect(PREVIEW_MAX_BYTES).toBe(1024 * 1024);
		expect(previewable({ type: "file", sizeBytes: 10 })).toBe(true);
		expect(previewable({ type: "file", sizeBytes: PREVIEW_MAX_BYTES })).toBe(
			true,
		);
		expect(
			previewable({ type: "file", sizeBytes: PREVIEW_MAX_BYTES + 1 }),
		).toBe(false);
		expect(previewable({ type: "dir", sizeBytes: 0 })).toBe(false);
	});

	it("text is decoded, binary is refused", () => {
		const enc = new TextEncoder();
		expect(decodePreview(enc.encode("hello\nпривет\n"))).toBe(
			"hello\nпривет\n",
		);
		expect(decodePreview(new Uint8Array([0x68, 0x00, 0x69]))).toBe(null);
		expect(decodePreview(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(null);
		expect(decodePreview(new Uint8Array([]))).toBe("");
	});
});

describe("upload strategy", () => {
	it("one PUT up to 64 MiB, chunks above", () => {
		expect(SINGLE_PUT_MAX_BYTES).toBe(64 * 1024 * 1024);
		expect(uploadStrategy(0)).toBe("put");
		expect(uploadStrategy(SINGLE_PUT_MAX_BYTES)).toBe("put");
		expect(uploadStrategy(SINGLE_PUT_MAX_BYTES + 1)).toBe("chunked");
	});
});

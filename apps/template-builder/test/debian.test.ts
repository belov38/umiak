import { createHash } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	DEBIAN_CLOUD,
	debianChecksum,
	debianFetch,
	debianImageFetch,
	debianImageUrl,
	fetchDebianImage,
	resolveDebianBase,
} from "../src/debian.ts";
import { pveImageName } from "../src/image.ts";
import {
	loadRecipe,
	loadVerifyScript,
	loadVersions,
	stepFile,
} from "../src/recipe.ts";
import { renderSeed } from "../src/seed.ts";
import { parseCheckLines } from "../src/verify.ts";
import { formatVersionsToml } from "../src/versions-update-linux.ts";

const templates = resolve(import.meta.dirname, "../../../infra/templates");
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "umiak-debian-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	vi.unstubAllGlobals();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const hash = (kind: string, data: string) =>
	createHash(kind).update(data).digest("hex");
const serial = "20261103-2651";
const url = debianImageUrl(serial);
const bytes = "test qcow2 bytes";
const base = {
	serial,
	url,
	sha256: hash("sha256", bytes),
	sha512: hash("sha512", bytes),
};

it("inherits shared steps and files but owns Debian pins, seed archive and VMID", () => {
	const r = loadRecipe(templates, "debian");
	if (r.os !== "linux") throw Error("wrong os");
	expect(r.source.distro).toBe("debian");
	expect(r.vmids).toEqual([594]);
	expect(stepFile(r, "20-docker")).toContain("/linux/steps/");
	const v = loadVersions(r);
	expect(v.base.url).toBe(debianImageUrl(v.base.serial));
	expect(v.docker.docker_ce).toContain("~debian.13~trixie");
	expect(v.tools).toEqual(
		loadVersions(loadRecipe(templates, "linux", "linux")).tools,
	);
	expect(formatVersionsToml(v)).toContain(`sha512 = "${v.base.sha512}"`);
	const pkg = join(tmp(), "agent.tar");
	writeFileSync(pkg, "test");
	const seed = renderSeed({
		recipe: r,
		versions: v,
		buildId: "test",
		version: "20261105.1",
		agentPackage: pkg,
		agentVersion: "test",
		updateKeys: "test",
		manifestBase: {},
	});
	expect(seed.get("user-data")).toContain("snapshot.debian.org");
	expect(seed.get("user-data")).toContain("Acquire::Retries");
	expect(pveImageName(v.base.serial)).toContain("debian-13-genericcloud");
});

it("keeps the same verify report grammar for Debian", () => {
	expect(loadVerifyScript(templates, "linux")).toContain("EXPECTED_VERSION=13");
	const report = parseCheckLines(
		"CHECK os PASS ID=debian VERSION_ID=13\nCHECK packages PASS installed\n",
	);
	expect(report.checks.map((c) => c.status)).toEqual(["PASS", "PASS"]);
});

it("validates checksums and serials", () => {
	expect(debianChecksum(`${base.sha512}  image.qcow2`, "image.qcow2")).toBe(
		base.sha512,
	);
	expect(() =>
		debianChecksum(`${base.sha256}  image.qcow2`, "image.qcow2"),
	).toThrow();
	expect(() => debianImageUrl("../../latest")).toThrow();
});

it("restricts pin metadata to cloud.debian.org with redirects disabled", async () => {
	const f = vi.fn().mockResolvedValue(new Response("ok"));
	vi.stubGlobal("fetch", f);
	await debianFetch(DEBIAN_CLOUD);
	expect(f.mock.calls[0]?.[1].redirect).toBe("error");
	await expect(debianFetch("http://cloud.debian.org/x")).rejects.toThrow();
	await expect(debianFetch("https://evil.example/x")).rejects.toThrow();
});

it("allows bounded HTTPS image redirects, rejects downgrade", async () => {
	const f = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: "https://mirror.example/image" },
			}),
		)
		.mockResolvedValueOnce(new Response(bytes));
	vi.stubGlobal("fetch", f);
	expect(await (await debianImageFetch(url)).text()).toBe(bytes);
	f.mockResolvedValue(
		new Response(null, {
			status: 302,
			headers: { location: "http://mirror.example/image" },
		}),
	);
	await expect(debianImageFetch(url)).rejects.toThrow(/HTTPS/);
	f.mockResolvedValue(
		new Response(null, { status: 302, headers: { location: url } }),
	);
	await expect(debianImageFetch(url)).rejects.toThrow(/too many/);
});

it("pins SHA256 only after checking Debian's HTTPS SHA512 listing", async () => {
	const name = url.split("/").at(-1);
	const f = vi
		.fn()
		.mockResolvedValueOnce(new Response(`<a href="${serial}/">`))
		.mockResolvedValueOnce(new Response(`${base.sha512}  ${name}`))
		.mockResolvedValueOnce(new Response(bytes));
	vi.stubGlobal("fetch", f);
	expect(await resolveDebianBase()).toEqual(base);
	f.mockResolvedValueOnce(new Response(`<a href="${serial}/">`))
		.mockResolvedValueOnce(new Response(`${base.sha512}  ${name}`))
		.mockResolvedValueOnce(new Response("corrupt"));
	await expect(resolveDebianBase()).rejects.toThrow(/mismatch/);
});

it("checks both pinned hashes for downloads and cached files", async () => {
	const cacheDir = tmp();
	const f = vi
		.fn()
		.mockImplementation(() => Promise.resolve(new Response(bytes)));
	vi.stubGlobal("fetch", f);
	const result = await fetchDebianImage({ cacheDir, base });
	expect(readFileSync(result.path, "utf8")).toBe(bytes);
	await fetchDebianImage({ cacheDir, base });
	expect(f).toHaveBeenCalledTimes(1);
	writeFileSync(result.path, "tampered");
	await fetchDebianImage({ cacheDir, base });
	expect(f).toHaveBeenCalledTimes(2);
	await expect(
		fetchDebianImage({ cacheDir, base: { ...base, sha512: "0".repeat(128) } }),
	).rejects.toThrow(/mismatch/);
	await expect(
		fetchDebianImage({
			cacheDir,
			base: { ...base, url: "https://evil.example/image" },
		}),
	).rejects.toThrow(/canonical/);
});

it("rejects incomplete or noncanonical Debian base pins", () => {
	const dir = tmp();
	cpSync(join(templates, "linux"), join(dir, "linux"), { recursive: true });
	cpSync(join(templates, "debian"), join(dir, "debian"), { recursive: true });
	const file = join(dir, "debian/versions.toml");
	const original = readFileSync(file, "utf8");
	for (const replacement of [
		original.replace(/^sha512 = .*\n/m, ""),
		original.replace("https://cloud.debian.org/", "https://evil.example/"),
	]) {
		writeFileSync(file, replacement);
		expect(() => loadVersions(loadRecipe(dir, "debian", "linux"))).toThrow(
			/Debian requires/,
		);
	}
});

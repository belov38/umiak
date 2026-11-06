import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { validateBuildAptProxy } from "../src/build-apt-proxy.ts";
import { renderOfflineSeed } from "../src/offline-seed.ts";
import { qemuBootSeed } from "../src/qemu-build.ts";

const proxy = "http://192.0.2.1:3142",
	snapshot = "20261030T000000Z";
const script = resolve(
	import.meta.dirname,
	"../../../infra/templates/linux/build-apt-proxy.py",
);
it("accepts an optional credential-free HTTP origin and rejects config/shell injection", () => {
	expect(validateBuildAptProxy(undefined)).toBeUndefined();
	expect(validateBuildAptProxy("")).toBeUndefined();
	expect(validateBuildAptProxy(`${proxy}/`)).toBe(proxy);
	for (const value of [
		"https://cache.test",
		"http://user:password@cache.test",
		"http://cache.test/path",
		"http://cache.test?query",
		"http://cache.test#fragment",
		"http://cache.test\n",
		'http://cache.test/";stuff',
		"http://cache.test/\\stuff",
	])
		expect(() => validateBuildAptProxy(value)).toThrow("UMIAK_BUILD_APT_PROXY");
});
it("configures signed snapshot URIs before bootstrap apt without persisting the URL in build inputs", () => {
	const seed = new Map<string, string | Buffer>([
		["user-data", "#cloud-config\nbootcmd: [[sh, -c, snapshot-pin]]\n"],
		["meta-data", "instance-id: fixture"],
		["network-config", "version: 2"],
		["build/env", "UMIAK_LAYER_MODE='capture'\n"],
	]);
	qemuBootSeed(seed, true, { url: proxy, snapshot });
	const yaml = String(seed.get("user-data")),
		config = parse(yaml, { version: "1.1" });
	expect(config.bootcmd.at(-1)).toEqual([
		"python3",
		"-I",
		"/mnt/seed/build/build-apt-proxy.py",
		"configure",
		snapshot,
		proxy,
	]);
	expect(config.bootcmd[1]).toEqual(["sh", "-c", "snapshot-pin"]);
	expect(config).toEqual(parse(yaml, { version: "1.2" }));
	expect(String(seed.get("build/env"))).not.toContain(proxy);
});
it("does not inject proxy configuration when unset or into offline replay", () => {
	const seed = renderOfflineSeed("0123456789abcdef01234567");
	qemuBootSeed(seed, false);
	const text = String(seed.get("user-data"));
	expect(text).not.toContain("build-apt-proxy.py");
	expect(text).not.toContain(proxy);
	expect(text).not.toContain("Acquire::http::Proxy");
	expect(() => qemuBootSeed(seed, false, { url: proxy, snapshot })).toThrow(
		"forbidden on offline replay",
	);
});
it("bootstrap proxy transformation removes discovery fields, preserves Signed-By and applies across apt source stanzas", () => {
	const root = mkdtempSync(join(tmpdir(), "build-apt-proxy-"));
	try {
		const sources = join(root, "etc/apt/sources.list.d/ubuntu.sources");
		mkdirSync(join(root, "etc/apt/sources.list.d"), { recursive: true });
		const original = `Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: resolute resolute-updates resolute-backports\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nSnapshot: ${snapshot}\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu\nSuites: resolute-security\nComponents: main\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nSnapshot: ${snapshot}\n`;
		writeFileSync(sources, original);
		execFileSync("python", [script, "configure", snapshot, proxy, root]);
		const text = readFileSync(sources, "utf8");
		expect(
			text.match(
				new RegExp(`URIs: http://snapshot.ubuntu.com/ubuntu/${snapshot}/`, "g"),
			),
		).toHaveLength(2);
		expect(text).not.toMatch(/^Snapshot:/m);
		expect(text).not.toMatch(/archive.ubuntu.com|security.ubuntu.com/);
		expect(text.match(/Signed-By:/g)).toHaveLength(2);
		expect(text).toContain("Suites: resolute-security");
		const config = readFileSync(
			join(root, "etc/apt/apt.conf.d/98umiak-build-proxy"),
			"utf8",
		);
		expect(config).toBe(`Acquire::http::Proxy "${proxy}";\n`);
		expect(config).not.toMatch(/trusted|Verify-Peer|AllowUnauthenticated/);
		expect(
			readFileSync(
				join(root, "var/lib/umiak-build/ubuntu.sources-before-proxy"),
				"utf8",
			),
		).toBe(original);
		execFileSync("python", [script, "sources", snapshot, sources]);
		expect(readFileSync(sources, "utf8")).toBe(text);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("Docker/xtradeb apt URI remaps apply only to capture with the proxy marker", () => {
	const root = mkdtempSync(join(tmpdir(), "apt-remap-"));
	try {
		const flag = join(root, "proxy.conf");
		writeFileSync(flag, "proxy fixture");
		const lib = readFileSync(
			resolve(import.meta.dirname, "../../../infra/templates/linux/lib.sh"),
			"utf8",
		);
		const helper = lib
			.slice(
				lib.indexOf("apt_capture_uri()"),
				lib.indexOf("# fetch_verify <url>"),
			)
			.replaceAll("/etc/apt/apt.conf.d/98umiak-build-proxy", flag);
		const uri = "https://download.docker.com/linux/ubuntu";
		for (const mode of ["capture", "replay", ""]) {
			const output = execFileSync(
				"bash",
				[
					"-euc",
					`${helper}\nUMIAK_LAYER_MODE='${mode}'; apt_capture_uri '${uri}'; apt_capture_uri https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/; apt_capture_uri https://other.invalid/packages`,
				],
				{ encoding: "utf8" },
			);
			expect(output.split("\n")[0]).toBe(
				mode === "capture" ? uri.replace("https:", "http:") : uri,
			);
			expect(output.split("\n")[1]).toBe(
				`${mode === "capture" ? "http" : "https"}://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/`,
			);
			expect(output).toContain("https://other.invalid/packages");
		}
		rmSync(flag);
		expect(
			execFileSync(
				"bash",
				[
					"-euc",
					`${helper}\nUMIAK_LAYER_MODE=capture; apt_capture_uri '${uri}'`,
				],
				{ encoding: "utf8" },
			).trim(),
		).toBe(uri);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

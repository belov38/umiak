// Publication policy is deliberately smaller than the set of all SPDX licenses.
// New/unclear inputs stop publication for review; they are never silently relabeled.
const permissive = new Set([
	"MIT",
	"Apache-2.0",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
	"CC0-1.0",
	"Unlicense",
	"BlueOak-1.0.0",
	"Python-2.0",
	"PSF-2.0",
	"CC-BY-4.0",
]);
export function redistributableNpmLicense(expression) {
	if (typeof expression !== "string" || !expression.trim()) return false;
	const tokens = expression.replace(/[()]/g, " ").trim().split(/\s+/);
	return (
		tokens.every((t) => t === "AND" || t === "OR" || permissive.has(t)) &&
		tokens.some((t) => permissive.has(t))
	);
}
const policy = [
	[
		"https://nodejs.org/dist/",
		"Node.js",
		"MIT AND LicenseRef-Node-Bundled-Notices",
		"https://github.com/nodejs/node",
	],
	[
		"https://go.dev/dl/",
		"Go",
		"BSD-3-Clause AND LicenseRef-Go-Notices",
		"https://go.dev/dl/",
	],
	[
		"https://static.rust-lang.org/",
		"Rust / rustup",
		"Apache-2.0 OR MIT",
		"https://github.com/rust-lang",
	],
	[
		"https://github.com/astral-sh/uv/releases/",
		"uv",
		"Apache-2.0 OR MIT",
		"https://github.com/astral-sh/uv",
	],
	[
		"https://github.com/cli/cli/releases/",
		"GitHub CLI",
		"MIT",
		"https://github.com/cli/cli",
	],
	[
		"https://github.com/LizardByte/Sunshine/releases/",
		"Sunshine",
		"GPL-3.0-only",
		"https://github.com/LizardByte/Sunshine",
	],
	[
		"https://github.com/MrCreativ3001/moonlight-web-stream/releases/",
		"moonlight-web",
		"GPL-3.0-only",
		"https://github.com/MrCreativ3001/moonlight-web-stream",
	],
	[
		"https://github.com/trycua/cua/releases/",
		"Cua Driver",
		"MIT",
		"https://github.com/trycua/cua",
	],
	[
		"https://github.com/sigstore/cosign/releases/",
		"cosign",
		"Apache-2.0",
		"https://github.com/sigstore/cosign",
	],
];
export function layerInventory({
	sourceCommit,
	facts,
	files,
	packages,
	npm,
	fetches,
	upstream = [],
}) {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const notice = (path) => {
		const file = byPath.get(path);
		if (!path?.startsWith("licenses/") || !file?.sizeBytes)
			throw Error(`License notice missing: ${path}`);
		return file;
	};
	const forbidden = /claude-code|(?:^|[/@-])bun(?:$|[-/])|opencode/i;
	for (const [tool, value] of Object.entries(facts.tools))
		if (["claude", "bun", "bunx", "opencode"].includes(tool) && value !== null)
			throw Error(`Vendor-only tool in layer: ${tool}`);
	const installed = new Map();
	const packageInventory = packages.map((p) => {
		if (forbidden.test(p.name) || !p.source || !p.sourceVersion)
			throw Error(`Unresolved package input: ${p.name}`);
		installed.set(p.name.split(":")[0], p.version);
		return {
			...p,
			license: "LicenseRef-Distribution-Copyright",
			noticeFile: notice(p.notice),
			sourceURL: `https://launchpad.net/ubuntu/+source/${encodeURIComponent(p.source)}/${encodeURIComponent(p.sourceVersion)}`,
		};
	});
	const actual = Object.entries(facts.packages).sort();
	if (JSON.stringify([...installed].sort()) !== JSON.stringify(actual))
		throw Error("License package manifest differs from exact capture facts");
	const npmInventory = npm.map((p) => {
		if (forbidden.test(p.name) || !redistributableNpmLicense(p.license))
			throw Error(`Unresolved/vendor-only npm input: ${p.name} (${p.license})`);
		if (
			!p.version ||
			!/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(p.integrity || "") ||
			!p.url?.startsWith("https://registry.npmjs.org/") ||
			!p.notices?.length
		)
			throw Error(`Incomplete npm provenance/notices: ${p.name}`);
		return { ...p, noticeFiles: p.notices.map(notice) };
	});
	const nonDebInputs = fetches.map((input) => {
		if (
			/github\.com\/(oven-sh\/bun|anomalyco\/opencode)\/|claude\.(ai|com)|claude-code-releases/.test(
				input.url,
			)
		)
			throw Error("Vendor-only payload in offline input closure");
		if (
			!files.some(
				(f) => f.path.startsWith("inputs/") && f.sha256 === input.sha256,
			)
		)
			throw Error("Captured input hash is missing from the layer");
		const entry = policy.find(([prefix]) => input.url.startsWith(prefix));
		if (!entry) throw Error(`Unresolved upstream input: ${input.url}`);
		const notices = upstream.filter((n) => n.name === entry[1]);
		if (!notices.length) throw Error(`Upstream notices missing: ${entry[1]}`);
		return {
			...input,
			name: entry[1],
			license: entry[2],
			source: entry[3],
			notices: notices.map((n) => ({ ...n, file: notice(n.path) })),
		};
	});
	return {
		format: "umiak-layer-inventory/v1",
		sourceCommit,
		packages: packageInventory,
		npm: npmInventory,
		nonDebInputs,
		debInputs: files.filter((f) => f.path.endsWith(".deb")),
		repositoryVerification: files.filter(
			(f) =>
				f.path.startsWith("apt/") &&
				/InRelease|Packages$|archive.asc$/.test(f.path),
		),
		noticeFiles: files.filter((f) => f.path.startsWith("licenses/")),
		vendorTools: {
			included: false,
			policy:
				"Installed online once per template build on the install node, after offline parity; never in CI or the published layer",
			tools: ["Claude Code", "Bun", "OpenCode"],
		},
	};
}

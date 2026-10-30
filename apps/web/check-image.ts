// `pnpm check:image` (S8 §13, §14.1): the dev auth stand-in must never ship.
// Fails if any file of the standalone build (.next/standalone) or of the
// static assets is named after it or contains its markers. Run after
// `next build`; the Dockerfile runs it too.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKERS = ["auth-proxy", "sbx_dev_identity", "/__dev/login"];

async function* files(dir: string): AsyncGenerator<string> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* files(p);
		else if (e.isFile()) yield p;
	}
}

const root = fileURLToPath(new URL(".next/", import.meta.url));
const dirs = process.argv.slice(2);
const targets =
	dirs.length > 0 ? dirs : [join(root, "standalone"), join(root, "static")];
const found: string[] = [];
let count = 0;
for (const dir of targets) {
	for await (const f of files(dir)) {
		count++;
		if (MARKERS.some((m) => f.includes(m))) {
			found.push(`${f}: file name`);
			continue;
		}
		// Only text-like files; node_modules binaries cannot hold our code.
		if (!/\.(js|mjs|cjs|json|ts|map|html|txt)$/.test(f)) continue;
		const text = await readFile(f, "utf8");
		const m = MARKERS.find((x) => text.includes(x));
		if (m !== undefined) found.push(`${f}: contains "${m}"`);
	}
}
if (count === 0) {
	console.error(
		`check:image: no files under ${targets.join(", ")}; run next build first`,
	);
	process.exit(1);
}
if (found.length > 0) {
	console.error(
		`check:image: dev auth code in the build:\n  ${found.join("\n  ")}`,
	);
	process.exit(1);
}
console.log(`check:image: ok (${count} files, no dev auth code)`);

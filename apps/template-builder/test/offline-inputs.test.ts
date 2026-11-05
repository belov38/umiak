import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("fetches once during capture and replays only the exact locally hashed input", () => {
	const root = mkdtempSync(join(tmpdir(), "umiak-inputs-"));
	try {
		const build = join(root, "build"),
			bin = join(root, "bin"),
			capture = join(root, "capture"),
			layer = join(root, "layer");
		mkdirSync(build);
		mkdirSync(bin);
		mkdirSync(layer);
		copyFileSync(
			new URL("../../../infra/templates/linux/lib.sh", import.meta.url),
			join(build, "lib.sh"),
		);
		writeFileSync(join(build, "env"), "");
		const payload = "pinned input";
		const sha = createHash("sha256").update(payload).digest("hex");
		writeFileSync(
			join(bin, "curl"),
			`#!/bin/bash\nprintf '%s' '${payload}' > "$8"\n`,
			{ mode: 0o755 },
		);
		const script = `. "$1/lib.sh"\nPATH="${bin}:$PATH"\nUMIAK_LAYER_MODE=$2\nUMIAK_CAPTURE_DIR=$3\nUMIAK_LAYER_ROOT=$4\nfetch_verify https://example.invalid/tool ${sha} "$5"`;
		// The fake fetcher records its output option without network access.
		writeFileSync(
			join(bin, "curl"),
			`#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf '%s' '${payload}' > "$1"; exit; fi; shift; done\nexit 1\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "sha256sum"),
			`#!/usr/bin/env python3
import hashlib,sys
sha,path=sys.stdin.read().strip().split("  ",1)
sys.exit(hashlib.sha256(open(path,"rb").read()).hexdigest()!=sha)
`,
			{ mode: 0o755 },
		);

		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		execFileSync(
			"bash",
			[
				"-euc",
				script,
				"fixture",
				build,
				"capture",
				capture,
				layer,
				join(root, "first"),
			],
			{ env },
		);
		expect(readFileSync(join(capture, "inputs", sha), "utf8")).toBe(payload);
		const input = JSON.parse(
			readFileSync(join(capture, "inputs.jsonl"), "utf8").trim(),
		);
		expect(input).toEqual({
			url: "https://example.invalid/tool",
			sha256: sha,
			sizeBytes: payload.length,
		});
		mkdirSync(join(layer, "inputs"));
		copyFileSync(join(capture, "inputs", sha), join(layer, "inputs", sha));
		writeFileSync(join(bin, "curl"), "#!/bin/bash\nexit 99\n", { mode: 0o755 });
		execFileSync(
			"bash",
			[
				"-euc",
				script,
				"fixture",
				build,
				"replay",
				capture,
				layer,
				join(root, "second"),
			],
			{ env },
		);
		expect(readFileSync(join(root, "second"), "utf8")).toBe(payload);
		writeFileSync(join(layer, "inputs", sha), "tampered");
		expect(() =>
			execFileSync(
				"bash",
				[
					"-euc",
					script,
					"fixture",
					build,
					"replay",
					capture,
					layer,
					join(root, "third"),
				],
				{ env, stdio: "pipe" },
			),
		).toThrow();
		expect(existsSync(join(root, "third"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

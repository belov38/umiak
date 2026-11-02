import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scripted `umiak` in a temporary directory: `umiak auth token --json` prints the
 * content of `out.json`, exits with the code in `exit` (default 0) and logs its
 * arguments to `calls.log`. Pass `env` to the SDK so that PATH finds it.
 */
export interface FakeUmiak {
	dir: string;
	env: Record<string, string>;
	setOutput(value: unknown): Promise<void>;
	setExit(code: number, stderr?: string): Promise<void>;
	/** Sleep this many seconds before answering; `ignoreTerm`: SIGTERM is ignored. */
	setSleep(seconds: number, o?: { ignoreTerm?: boolean }): Promise<void>;
	calls(): Promise<string[]>;
	cleanup(): Promise<void>;
}

const SCRIPT = `#!/bin/sh
echo "$*" >> "$FAKE_UMIAK_DIR/calls.log"
if [ -f "$FAKE_UMIAK_DIR/sleep" ]; then
  s=$(cat "$FAKE_UMIAK_DIR/sleep")
  if [ -f "$FAKE_UMIAK_DIR/ignore-term" ]; then
    trap '' TERM
    exec sleep "$s"
  fi
  sleep "$s"
fi
code=0
[ -f "$FAKE_UMIAK_DIR/exit" ] && code=$(cat "$FAKE_UMIAK_DIR/exit")
if [ "$code" != 0 ]; then
  [ -f "$FAKE_UMIAK_DIR/stderr" ] && cat "$FAKE_UMIAK_DIR/stderr" >&2
  exit "$code"
fi
cat "$FAKE_UMIAK_DIR/out.json"
`;

export async function fakeUmiak(): Promise<FakeUmiak> {
	const dir = await mkdtemp(join(tmpdir(), "fake-umiak-"));
	await writeFile(join(dir, "umiak"), SCRIPT);
	await chmod(join(dir, "umiak"), 0o755);
	return {
		dir,
		env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_UMIAK_DIR: dir },
		async setOutput(value) {
			await writeFile(join(dir, "out.json"), JSON.stringify(value));
		},
		async setExit(code, stderr = "") {
			await writeFile(join(dir, "exit"), String(code));
			await writeFile(join(dir, "stderr"), stderr);
		},
		async setSleep(seconds, o = {}) {
			await writeFile(join(dir, "sleep"), String(seconds));
			if (o.ignoreTerm) await writeFile(join(dir, "ignore-term"), "1");
		},
		async calls() {
			try {
				const log = await readFile(join(dir, "calls.log"), "utf8");
				return log.split("\n").filter((l) => l !== "");
			} catch {
				return [];
			}
		},
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

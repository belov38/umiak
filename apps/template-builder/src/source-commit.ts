import { execFileSync } from "node:child_process";

const ENV_COMMIT = /^[0-9a-f]{40}(-dirty)?$/;

/**
 * Source commit recorded in the build manifest (provenance).
 * Order: UMIAK_SOURCE_COMMIT (baked into release images, which have no .git),
 * then git, then the literal "unknown". Never throws.
 */
export function sourceCommit(
	repoRoot: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const fromEnv = env.UMIAK_SOURCE_COMMIT?.trim();
	if (fromEnv !== undefined && ENV_COMMIT.test(fromEnv)) return fromEnv;
	try {
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: repoRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		const head = git("rev-parse", "HEAD");
		return git("status", "--porcelain").length > 0 ? `${head}-dirty` : head;
	} catch {
		return "unknown";
	}
}

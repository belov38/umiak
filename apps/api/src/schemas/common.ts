// Schema pieces shared by the resource routes: path parameters, paging,
// durations, labels and the env/secret sets (S7 §5.2, §5.6, §8.3).
// Request objects are strict (unknown fields are 400 validation).
import { z } from "@hono/zod-openapi";

export const Timestamp = z.iso
	.datetime()
	.openapi({ description: "ISO 8601 UTC with milliseconds" });

export const NullableTimestamp = Timestamp.nullable();

/**
 * A display name without control characters (Unicode Cc: U+0000-U+001F and
 * U+007F-U+009F). Written without regex flags: the document carries only
 * the source of the regex as `pattern`, so a `/u` regex (\p{Cc}) would put
 * a pattern no JSON Schema validator matches into the document.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the range is what is refused
export const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f-\u009f]+$/;

export const SandboxParams = z.object({
	sandbox: z.string().openapi({
		param: { name: "sandbox", in: "path" },
		description: "Sandbox id (`sb_...`) or slug",
		example: "quiet-otter-lamp",
	}),
});

export const OperationParams = z.object({
	operation: z.string().openapi({
		param: { name: "operation", in: "path" },
		description: "Operation id (`op_...`)",
		example: "op_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
});

export const LIST_MAX_LIMIT = 200;

export const PageQuery = {
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(LIST_MAX_LIMIT)
		.optional()
		.openapi({ description: "Page size, 1-200 (default 50)" }),
	cursor: z.string().min(1).optional().openapi({
		description: "`nextCursor` of the previous page, unchanged",
	}),
};

export const Labels = z.record(z.string(), z.string()).openapi("Labels", {
	description:
		"Free-form string labels: up to 64, keys up to 128 and values up to 256 characters",
	example: { session: "42" },
});

export const TtlSeconds = z.int().positive().nullable().openapi({
	description:
		"Lifetime from ready in seconds; the deadline is ready + ttl; null: no TTL",
});

export const IDLE_TIMEOUT_MIN_SECONDS = 60;

export const IdleTimeoutSeconds = z
	.int()
	.min(IDLE_TIMEOUT_MIN_SECONDS)
	.nullable()
	.openapi({
		description:
			"Stop after this many idle seconds (at least 60); null disables idle-stop",
	});

const ENV_DESCRIPTION =
	"Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without NUL, " +
	"256 KiB per set. `SBX_` is reserved except SBX_API_KEY, SBX_API_URL, SBX_TEAM, SBX_PROFILE. " +
	"Values with a newline are not visible in SSH sessions.";

export const EnvVars = z
	.record(z.string(), z.string())
	.openapi("EnvVars", { description: ENV_DESCRIPTION });

export const EnvVarsPatch = z
	.record(z.string(), z.string().nullable())
	.openapi("EnvVarsPatch", {
		description: `${ENV_DESCRIPTION} Merged by key: null deletes the key.`,
	});

const fileFields = {
	contentBase64: z
		.string()
		.openapi({ description: "File content, base64 (up to 1 MiB decoded)" }),
	mode: z.int().min(0).max(0o7777).optional().openapi({
		description: "File mode (default 0440 = 288)",
		example: 288,
	}),
	linkPath: z.string().optional().openapi({
		description: "Absolute path of a symlink to the file in the guest",
		example: "/home/user/.config/gcloud/key.json",
	}),
};

export const SecretFileInput = z
	.strictObject({
		name: z
			.string()
			.openapi({ description: "`[A-Za-z0-9._-]{1,128}`", example: "gcp.json" }),
		...fileFields,
	})
	.openapi("SecretFileInput", {
		description:
			"A secret file on tmpfs in the guest: up to 32 files, 8 MiB in total",
	});

export const SecretFileInputs = z.array(SecretFileInput);

export const SecretFilesPatch = z
	.record(z.string(), z.strictObject(fileFields).nullable())
	.openapi("SecretFilesPatch", {
		description:
			"Secret files by name: a file replaces the one with that name, null deletes it",
	});

export const EnvPatchFields = {
	env: EnvVarsPatch.optional(),
	secrets: EnvVarsPatch.optional().openapi({
		description: "Secret variables (tmpfs in the guest); merged like env",
	}),
	secretFiles: SecretFilesPatch.optional(),
};

/** Comma-separated list in a query string. */
export function csvList(s: string | undefined): string[] | undefined {
	if (s === undefined) return undefined;
	return s
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v !== "");
}

/** Removes undefined fields (inputs of core use exact optional types). */
export function compact<T extends object>(
	o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
	return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** S9 §24.8: fork and saved snapshot of a running Windows sandbox. */
export const ForceStopField = z
	.boolean()
	.optional()
	.openapi({
		description:
			"Windows only: a running Windows sandbox is snapshotted from a stopped VM. With true, " +
			"the source is stopped (running commands, sessions and connections end), snapshotted " +
			"and started again; the operation's `forceStop` reports the restart. Without it, a " +
			"running Windows source answers 409 `snapshot_requires_stop`. Ignored for Linux " +
			"(snapshotted while running) and for a stopped source.",
	});

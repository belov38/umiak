// Environments of a team (S8 §10.2): named env, secrets, secret files and
// repositories that a new sandbox gets at create. Secret values are never
// returned: only names and file metadata; env values only from GET of one.
import { z } from "@hono/zod-openapi";
import {
	EnvPatchFields,
	EnvVars,
	SecretFileInputs,
	Timestamp,
} from "./common.ts";

export const ENVIRONMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_REPOSITORIES = 20;

const EnvironmentName = z
	.string()
	.regex(ENVIRONMENT_NAME_RE)
	// An id-shaped name would be ambiguous with an id in the path.
	.refine((s) => !UUID_RE.test(s), "must not have the form of a UUID")
	.openapi({
		description: "Unique in the team: `^[a-z0-9][a-z0-9-]{0,62}$`",
		example: "production",
	});

export const EnvironmentParams = z.object({
	environment: z.string().openapi({
		param: { name: "environment", in: "path" },
		description: "Environment id (`env_...`) or name",
		example: "production",
	}),
});

/**
 * `https://host/...`, `ssh://[user@]host/...` or `user@host:path`, without a
 * password, a token, a query or a fragment (the URL is shown to every reader
 * of the environment, and a query string is where tokens go).
 */
function repositoryUrlProblem(url: string): string | null {
	if (url.includes("?") || url.includes("#")) {
		return "must not contain a query (?) or a fragment (#)";
	}
	const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/;
	if (scp.test(url) && !url.includes("://")) return null;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "must be an https://, ssh:// or user@host:path URL";
	}
	if (u.protocol !== "https:" && u.protocol !== "ssh:") {
		return "must be an https://, ssh:// or user@host:path URL";
	}
	if (u.hostname === "") return "must name a host";
	if (u.password !== "" || (u.protocol === "https:" && u.username !== "")) {
		return "must not contain credentials";
	}
	return null;
}

function repositoryPathProblem(path: string): string | null {
	if (path.startsWith("/")) return "must be relative to the user's home";
	if (path.split("/").some((s) => s === "..")) return "must not contain ..";
	return null;
}

const RepositoryInput = z
	.strictObject({
		url: z.string().min(1).max(2048).openapi({
			description:
				"https://..., ssh://... or git@host:org/repo.git, without credentials, a query or a fragment",
			example: "https://github.com/acme/web.git",
		}),
		branch: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[^\s\0]+$/)
			.optional()
			.openapi({ description: "Branch or tag" }),
		path: z
			.string()
			.min(1)
			.max(1024)
			.regex(/^[^\0]+$/)
			.optional()
			.openapi({
				description:
					"Directory relative to the home of `user` (default: the repository name)",
			}),
	})
	.superRefine((r, ctx) => {
		const u = repositoryUrlProblem(r.url);
		if (u !== null) ctx.addIssue({ code: "custom", path: ["url"], message: u });
		if (r.path !== undefined) {
			const p = repositoryPathProblem(r.path);
			if (p !== null) {
				ctx.addIssue({ code: "custom", path: ["path"], message: p });
			}
		}
	})
	.openapi("RepositoryInput");

const RepositoryInputs = z
	.array(RepositoryInput)
	.max(MAX_REPOSITORIES)
	.openapi({
		description:
			"Up to 20 repositories; stored and returned only (cloning comes later)",
	});

export const CreateEnvironmentRequest = z
	.strictObject({
		name: EnvironmentName,
		isDefault: z
			.boolean()
			.optional()
			.openapi({
				description:
					"Applied to every create of the team that names no environment; the previous " +
					"default stops being one",
			}),
		env: EnvVars.optional(),
		secrets: EnvVars.optional().openapi({
			description: "Secret variables (never returned)",
		}),
		secretFiles: SecretFileInputs.optional(),
		repositories: RepositoryInputs.optional(),
		excludeOwnerSecrets: z.boolean().optional().openapi({
			description:
				"Do not pass the creating user's personal secrets into the sandbox (stored only)",
		}),
	})
	.openapi("CreateEnvironmentRequest");

export const UpdateEnvironmentRequest = z
	.strictObject({
		name: EnvironmentName.optional(),
		isDefault: z.boolean().optional(),
		...EnvPatchFields,
		repositories: RepositoryInputs.optional().openapi({
			description: "Replaces the list whole",
		}),
		excludeOwnerSecrets: z.boolean().optional(),
	})
	.openapi("UpdateEnvironmentRequest", {
		description:
			"Sets merge by key (null deletes a key or a file); repositories are replaced; revision + 1",
	});

const environmentFields = {
	id: z.string().openapi({ example: "env_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
	name: z.string().openapi({ example: "production" }),
	isDefault: z.boolean(),
	revision: z
		.int()
		.openapi({ description: "1 on create, + 1 on every change" }),
	envKeys: z
		.array(z.string())
		.openapi({ description: "Names of env variables" }),
	secretKeys: z
		.array(z.string())
		.openapi({ description: "Names of secret variables (values never)" }),
	secretFiles: z.array(
		z.object({
			name: z.string(),
			mode: z.int(),
			linkPath: z.string().nullable(),
			sizeBytes: z.int(),
		}),
	),
	repositories: z.array(
		z.object({
			url: z.string(),
			branch: z.string().optional(),
			path: z.string().optional(),
		}),
	),
	excludeOwnerSecrets: z.boolean(),
	createdAt: Timestamp,
	updatedAt: Timestamp,
	updatedBy: z.string().nullable().openapi({
		description: "User (`usr_...`) of the last change; null for a team key",
	}),
};

export const EnvironmentSummarySchema = z
	.object(environmentFields)
	.openapi("EnvironmentSummary", {
		description: "An environment without values",
	});

export const EnvironmentSchema = z
	.object({
		...environmentFields,
		env: EnvVars.openapi({ description: "Env variables with their values" }),
	})
	.openapi("Environment", {
		description: "An environment with its env values (secret values never)",
	});

export const EnvironmentListSchema = z
	.object({ data: z.array(EnvironmentSummarySchema) })
	.openapi("EnvironmentList", {
		description: "Environments of the team by name",
	});

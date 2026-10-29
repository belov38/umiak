// Env and secrets of a sandbox (S7 §8.3, S8 C2). Secret values are never
// returned: only their names and file metadata.
import { z } from "@hono/zod-openapi";
import { EnvPatchFields, EnvVars, SecretFileInputs } from "./common.ts";

const envViewFields = {
	env: EnvVars.openapi({ description: "Variables with their values" }),
	secretKeys: z
		.array(z.string())
		.openapi({ description: "Names of the secret variables (values never)" }),
	secretFiles: z.array(
		z.object({
			name: z.string(),
			mode: z.int(),
			linkPath: z.string().nullable(),
			sizeBytes: z.int(),
		}),
	),
};

export const SandboxEnvSchema = z.object(envViewFields).openapi("SandboxEnv", {
	description: "Env of the sandbox, names of its secrets and secret files",
});

export const SandboxEnvUpdateSchema = z
	.object({
		delivered: z.boolean().openapi({
			description:
				"The running agent got the new sets; false when the sandbox is not ready or the " +
				"agent is unreachable (they are applied at the next resume). New commands see " +
				"them, running ones do not",
		}),
		...envViewFields,
	})
	.openapi("SandboxEnvUpdate");

export const EnvReplaceRequest = z
	.strictObject({
		env: EnvVars.optional(),
		secrets: EnvVars.optional().openapi({
			description: "Secret variables (tmpfs in the guest)",
		}),
		secretFiles: SecretFileInputs.optional(),
	})
	.openapi("EnvReplaceRequest", {
		description: "Each given set replaces its set whole; the others stay",
	});

export const EnvPatchRequest = z
	.strictObject(EnvPatchFields)
	.openapi("EnvPatchRequest", {
		description:
			"Merge by key: a value sets the key, null deletes it; files by name",
	});

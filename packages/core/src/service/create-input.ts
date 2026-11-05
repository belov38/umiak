import type {
	PlatformDefaults,
	SizeConfig,
	TemplateConfig,
} from "@umiak/config";
import { canonicalTemplateSlug } from "@umiak/config";
import {
	templateUnavailable,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import {
	type SecretFile,
	type SecretSets,
	validateSecretSets,
} from "../secrets.ts";
import { validateSlug } from "../slug.ts";
import { checkCapacityWait } from "./capacity-wait.ts";
import type { SandboxServiceDeps } from "./common.ts";
import {
	checkKnownKeys,
	checkLabels,
	checkName,
	checkSeconds,
	checkString,
	isPlainObject,
} from "./validate.ts";

// Input of create (S7 §8.2): shape checks, template/size and duration defaults.

export interface CreateInput {
	capacityWaitSeconds?: number;
	template?: string;
	size?: string;
	name?: string | null;
	slug?: string;
	labels?: Record<string, string>;
	env?: Record<string, string>;
	secrets?: Record<string, string>;
	secretFiles?: SecretFile[];
	/** null: no TTL. Default `PlatformDefaults.ttlSeconds`. */
	ttlSeconds?: number | null;
	/** null: no idle-stop. Default `PlatformDefaults.idleTimeoutSeconds`. */
	idleTimeoutSeconds?: number | null;
	/** Create from a saved snapshot of the team (always cold). */
	from?: { snapshot: string };
	/** S8 §10; only null/absent until S8 provides environments. */
	environment?: string | null;
	/** S8 §10; only false/absent until S8 provides environments. */
	excludeOwnerSecrets?: boolean;
}

const CREATE_KEYS: readonly (keyof CreateInput)[] = [
	"capacityWaitSeconds",
	"template",
	"size",
	"name",
	"slug",
	"labels",
	"env",
	"secrets",
	"secretFiles",
	"ttlSeconds",
	"idleTimeoutSeconds",
	"from",
	"environment",
	"excludeOwnerSecrets",
];

const NO_ENVIRONMENTS = "environments are not available until S8";

export function validateCreateInput(input: CreateInput): SecretSets {
	if (!isPlainObject(input as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkCapacityWait(input.capacityWaitSeconds, issues);
	checkKnownKeys(input as Record<string, unknown>, CREATE_KEYS, issues);
	if (input.template !== undefined)
		checkString("template", input.template, issues);
	if (input.size !== undefined) checkString("size", input.size, issues);
	if (input.name !== undefined) checkName("name", input.name, issues);
	if (input.labels !== undefined) checkLabels("labels", input.labels, issues);
	if (input.ttlSeconds !== undefined) {
		checkSeconds("ttlSeconds", input.ttlSeconds, issues, { nullable: true });
	}
	if (input.idleTimeoutSeconds !== undefined) {
		checkSeconds("idleTimeoutSeconds", input.idleTimeoutSeconds, issues, {
			nullable: true,
		});
	}
	if (input.from !== undefined) {
		if (!isPlainObject(input.from)) {
			issues.push({ path: "from", message: "must be {snapshot: <name>}" });
		} else {
			checkKnownKeys(input.from, ["snapshot"], issues);
			checkString("from.snapshot", input.from.snapshot, issues);
		}
	}
	if (input.environment !== undefined && input.environment !== null) {
		issues.push({ path: "environment", message: NO_ENVIRONMENTS });
	}
	if (
		input.excludeOwnerSecrets !== undefined &&
		input.excludeOwnerSecrets !== false
	) {
		issues.push({
			path: "excludeOwnerSecrets",
			message:
				typeof input.excludeOwnerSecrets === "boolean"
					? NO_ENVIRONMENTS
					: "must be a boolean",
		});
	}
	if (issues.length > 0) throw validation(issues);
	if (input.slug !== undefined) validateSlug(input.slug);
	const sets: SecretSets = {
		env: input.env ?? {},
		secrets: input.secrets ?? {},
		secretFiles: input.secretFiles ?? [],
	};
	validateSecretSets(sets);
	return sets;
}

/** `template_unavailable` for an unknown or disabled template (create's check). */
export async function checkTemplateEnabled(
	deps: SandboxServiceDeps,
	templateSlug: string,
): Promise<TemplateConfig> {
	const template = await deps.config.template(
		canonicalTemplateSlug(templateSlug),
	);
	if (template === null || !template.enabled) {
		throw templateUnavailable(templateSlug);
	}
	return template;
}

export async function resolveTemplate(
	deps: SandboxServiceDeps,
	templateSlug: string,
	sizeSlug: string | undefined,
): Promise<{ template: TemplateConfig; size: SizeConfig }> {
	const template = await checkTemplateEnabled(deps, templateSlug);
	const slug = sizeSlug ?? template.defaultSize;
	const size = template.allowedSizes.includes(slug)
		? await deps.config.size(slug)
		: null;
	if (size === null) throw templateUnavailable(templateSlug, slug);
	return { template, size };
}

export function resolveDurations(
	input: CreateInput,
	defaults: PlatformDefaults,
): { ttlSeconds: number | null; idleTimeoutSeconds: number | null } {
	const ttlSeconds =
		input.ttlSeconds === undefined ? defaults.ttlSeconds : input.ttlSeconds;
	if (ttlSeconds !== null && ttlSeconds > defaults.maxTtlSeconds) {
		throw validation([
			{
				path: "ttlSeconds",
				message: `must be at most ${defaults.maxTtlSeconds} seconds`,
			},
		]);
	}
	const idleTimeoutSeconds =
		input.idleTimeoutSeconds === undefined
			? defaults.idleTimeoutSeconds
			: input.idleTimeoutSeconds;
	return { ttlSeconds, idleTimeoutSeconds };
}

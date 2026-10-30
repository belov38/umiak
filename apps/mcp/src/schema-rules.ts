// The schema subset every MCP client understands (S11 7.2), checked on the
// JSON Schema the server publishes in tools/list, and the tool name rule (7.1).

const FORBIDDEN_KEYWORDS = [
	"oneOf",
	"anyOf",
	"allOf",
	"not",
	"$ref",
	"$defs",
	"definitions",
	"if",
	"then",
	"else",
	"propertyNames",
] as const;

const ALLOWED_TYPES = new Set([
	"string",
	"integer",
	"number",
	"boolean",
	"array",
	"object",
]);

const PROPERTY_NAME = /^[a-z][a-z0-9_]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lintType(node: Record<string, unknown>, where: string, out: string[]) {
	const { type } = node;
	if (Array.isArray(type)) {
		out.push(`${where}: type is an array (${JSON.stringify(type)})`);
	} else if (type === undefined) {
		out.push(`${where}: has no type (any value)`);
	} else if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
		out.push(
			`${where}: type ${JSON.stringify(type)} is not one of ${[...ALLOWED_TYPES].join(", ")}`,
		);
	}
}

// A dictionary (env, labels) maps strings to strings, nothing else.
function lintDictValues(value: unknown, where: string, out: string[]) {
	if (typeof value === "boolean") return;
	const keys = isPlainObject(value) ? Object.keys(value) : [];
	if (!isPlainObject(value) || value.type !== "string" || keys.length !== 1) {
		out.push(
			`${where}: additionalProperties must be {"type":"string"} (got ${JSON.stringify(value)})`,
		);
	}
}

function lintNode(
	node: unknown,
	where: string,
	isProperty: boolean,
	out: string[],
): void {
	if (!isPlainObject(node)) {
		out.push(`${where}: schema is not an object`);
		return;
	}
	for (const key of FORBIDDEN_KEYWORDS) {
		if (key in node) out.push(`${where}: uses ${key}`);
	}
	if (where !== "root") lintType(node, where, out);
	if ("nullable" in node) out.push(`${where}: uses nullable`);
	if ("enum" in node) {
		const values = node.enum;
		if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
			out.push(`${where}: enum values must be strings`);
		}
	}
	if ("const" in node && typeof node.const !== "string") {
		out.push(`${where}: const must be a string`);
	}
	if (
		isProperty &&
		(typeof node.description !== "string" || node.description.trim() === "")
	) {
		out.push(`${where}: has no description`);
	}
	if (isPlainObject(node.properties)) {
		const prefix = where === "root" ? "" : `${where}.`;
		for (const [name, child] of Object.entries(node.properties)) {
			if (!PROPERTY_NAME.test(name)) {
				out.push(`${prefix}${name}: property name is not snake_case`);
			}
			lintNode(child, `${prefix}${name}`, true, out);
		}
	}
	if ("prefixItems" in node) {
		out.push(`${where}: is a tuple (prefixItems); use an object instead`);
	} else if (isPlainObject(node.items)) {
		lintNode(node.items, `${where}[]`, false, out);
	} else if (node.type === "array") {
		out.push(`${where}: array without an items schema`);
	}
	if ("additionalProperties" in node) {
		lintDictValues(node.additionalProperties, where, out);
	}
}

/** Violations of the 7.2 subset in a published input schema; empty when it fits. */
export function lintToolSchema(name: string, schema: unknown): string[] {
	const out: string[] = [];
	if (!isPlainObject(schema) || schema.type !== "object") {
		out.push("root: type must be object");
	}
	if (isPlainObject(schema)) lintNode(schema, "root", false, out);
	return out.map((m) => `${name}: ${m}`);
}

/** Violations of the tool name rule (snake_case ASCII, at most 40 characters). */
export function lintToolName(name: string): string[] {
	return TOOL_NAME.test(name)
		? []
		: [
				`${JSON.stringify(name)}: tool name must match ${TOOL_NAME.source} (snake_case, at most 40 characters)`,
			];
}

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
] as const;

const PROPERTY_NAME = /^[a-z][a-z0-9_]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
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
	if (Array.isArray(node.type)) {
		out.push(`${where}: type is an array (${JSON.stringify(node.type)})`);
	}
	if ("nullable" in node) out.push(`${where}: uses nullable`);
	if ("enum" in node) {
		const values = node.enum;
		if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
			out.push(`${where}: enum values must be strings`);
		}
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
	if (Array.isArray(node.items)) {
		out.push(`${where}: items is a tuple`);
	} else if (node.items !== undefined) {
		lintNode(node.items, `${where}[]`, false, out);
	}
	if (isPlainObject(node.additionalProperties)) {
		lintNode(node.additionalProperties, `${where}{}`, false, out);
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

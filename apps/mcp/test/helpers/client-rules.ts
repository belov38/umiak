// What each target client does with a published tool (S11 7.1, 7.2, 14.1):
// rules as plain data plus small checkers over the tool name and the
// inputSchema of tools/list. The rules are deliberately conservative: only
// what is known to break a client is forbidden, so a pass means "no known
// reason for this client to reject or mangle the tool".
//
// Sources (behaviour of the clients as documented and observed, 2026-10):
// - Claude Code: shows an MCP tool to the model as `mcp__<server>__<tool>`
//   (Claude Code docs, "MCP"); the Anthropic Messages API accepts tool names
//   matching ^[a-zA-Z0-9_-]{1,64}$ and an input_schema whose root is an
//   object (Anthropic API reference, "tools"). The schema is passed on.
// - Codex (OpenAI): MCP tools are named `mcp__<server>__<tool>`; OpenAI
//   function names are limited to ^[a-zA-Z0-9_-]{1,64}$. Codex sends MCP
//   tools as non-strict function tools, parameters must be an object schema;
//   an array without `items` is rejected by the Responses API (400
//   "array schema missing items"). The keyword set below is what OpenAI
//   documents for function parameters (Structured Outputs, supported schemas)
//   plus the annotation and size keywords that non-strict mode takes
//   (`description`, `default`, `title`, `minLength`, `maxLength`). Codex's own
//   sanitizer drops keywords it does not know, so an unknown keyword costs a
//   constraint, but the set keeps our schemas inside what OpenAI itself takes.
// - OpenCode: passes the schema to the provider API as is (through the AI
//   SDK), naming the tool `<server>_<tool>`; so a tool must satisfy the
//   Anthropic and the OpenAI rules at once (both name rules, the OpenAI
//   keyword set, root object, arrays with items).
// - Gemini CLI: removes `$schema` and `additionalProperties` from MCP tool
//   schemas before the request, and the Gemini API takes an OpenAPI 3.0
//   subset of JSON Schema (Gemini API reference, "Schema"). The Gemini API
//   names a function with letters, digits, `_`, `.`, `:`, `-`, at most 64
//   characters, starting with a letter or `_`; Gemini CLI prefixes the
//   server name (`mcp_<server>_<tool>`).
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS: under NodeNext the default import is the module
// object and `.default` the function.
const addFormats =
	addFormatsModule as unknown as typeof addFormatsModule.default;

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
	[key: string]: Json;
}

export const SERVER_NAME = "sbx";

export interface ClientRules {
	client: string;
	/** The name the model sees for tool `name` of server `sbx`. */
	qualifiedName(name: string): string;
	namePattern: RegExp;
	/** Longest qualified name. */
	nameMaxLength: number;
	/** Every array schema must have `items` (OpenAI rejects it otherwise). */
	arraysNeedItems: boolean;
	/** Keywords that reach the model API; undefined: any (the schema is passed on). */
	allowedKeywords?: ReadonlySet<string>;
	/** What the client does to the schema before sending it. */
	transform?(schema: JsonObject): JsonObject;
	/** The transformed schema must stay valid draft-07 JSON Schema. */
	mustStayValid?: boolean;
	/** The transformed schema keeps `required` of every object. */
	keepsRequired?: boolean;
}

/** OpenAI function parameters (see the header). */
export const OPENAI_KEYWORDS: ReadonlySet<string> = new Set([
	"$schema",
	"type",
	"description",
	"title",
	"properties",
	"required",
	"items",
	"enum",
	"const",
	"default",
	"additionalProperties",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minItems",
	"maxItems",
]);

/** The subset of OpenAPI 3.0 that the Gemini API takes (spec 14.1). */
export const GEMINI_KEYWORDS: ReadonlySet<string> = new Set([
	"type",
	"description",
	"enum",
	"properties",
	"required",
	"items",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"pattern",
	"default",
	"format",
]);

function isObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Calls `visit` on the schema and on every sub-schema, with a readable path. */
export function walkSchema(
	node: JsonObject,
	visit: (n: JsonObject, path: string) => void,
	path = "root",
): void {
	visit(node, path);
	if (isObject(node.properties)) {
		for (const [name, c] of Object.entries(node.properties)) {
			if (isObject(c)) walkSchema(c, visit, `${path}.${name}`);
		}
	}
	if (isObject(node.items)) walkSchema(node.items, visit, `${path}[]`);
	if (isObject(node.additionalProperties)) {
		walkSchema(node.additionalProperties, visit, `${path}{}`);
	}
}

/** Copy of the schema without `keys`, at every schema level. */
export function stripKeywords(
	node: JsonObject,
	keys: readonly string[],
): JsonObject {
	const out: JsonObject = {};
	for (const [k, v] of Object.entries(node)) {
		if (keys.includes(k)) continue;
		if (k === "properties" && isObject(v)) {
			out[k] = Object.fromEntries(
				Object.entries(v).map(([n, c]) => [
					n,
					isObject(c) ? stripKeywords(c, keys) : c,
				]),
			);
		} else if ((k === "items" || k === "additionalProperties") && isObject(v)) {
			out[k] = stripKeywords(v, keys);
		} else {
			out[k] = v;
		}
	}
	return out;
}

const ANTHROPIC_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export const CLAUDE_CODE: ClientRules = {
	client: "Claude Code",
	qualifiedName: (n) => `mcp__${SERVER_NAME}__${n}`,
	namePattern: ANTHROPIC_NAME,
	nameMaxLength: 64,
	arraysNeedItems: false,
};

export const CODEX: ClientRules = {
	client: "Codex",
	qualifiedName: (n) => `mcp__${SERVER_NAME}__${n}`,
	namePattern: /^[a-zA-Z0-9_-]{1,64}$/,
	nameMaxLength: 64,
	arraysNeedItems: true,
	allowedKeywords: OPENAI_KEYWORDS,
};

export const OPENCODE: ClientRules = {
	client: "OpenCode",
	qualifiedName: (n) => `${SERVER_NAME}_${n}`,
	// Both providers' name rules are the same pattern; kept as the union.
	namePattern: /^[a-zA-Z0-9_-]{1,64}$/,
	nameMaxLength: 64,
	arraysNeedItems: true,
	allowedKeywords: OPENAI_KEYWORDS,
};

export const GEMINI_CLI: ClientRules = {
	client: "Gemini CLI",
	qualifiedName: (n) => `mcp_${SERVER_NAME}_${n}`,
	namePattern: /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/,
	nameMaxLength: 64,
	arraysNeedItems: true,
	allowedKeywords: GEMINI_KEYWORDS,
	transform: (schema) =>
		stripKeywords(schema, ["$schema", "additionalProperties"]),
	mustStayValid: true,
	keepsRequired: true,
};

export const ALL_CLIENTS: readonly ClientRules[] = [
	CLAUDE_CODE,
	CODEX,
	OPENCODE,
	GEMINI_CLI,
];

const ajv = new Ajv({ strict: true });
addFormats(ajv);

function requiredOf(schema: JsonObject): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	walkSchema(schema, (n, path) => {
		if (Array.isArray(n.required)) out[path] = [...(n.required as string[])];
	});
	return out;
}

/** Violations of `rules` by tool `name` with this published inputSchema; empty when it fits. */
export function checkClient(
	rules: ClientRules,
	name: string,
	published: JsonObject,
): string[] {
	const out: string[] = [];
	const who = `${rules.client}: ${name}`;
	const qualified = rules.qualifiedName(name);
	if (qualified.length > rules.nameMaxLength) {
		out.push(
			`${who}: ${qualified} is ${qualified.length} characters (max ${rules.nameMaxLength})`,
		);
	}
	if (!rules.namePattern.test(qualified)) {
		out.push(`${who}: ${qualified} does not match ${rules.namePattern.source}`);
	}
	if (published.type !== "object") out.push(`${who}: root type is not object`);
	if (!isObject(published.properties)) {
		out.push(`${who}: root has no properties`);
	}

	const sent =
		rules.transform === undefined ? published : rules.transform(published);
	walkSchema(sent, (n, path) => {
		if (rules.arraysNeedItems && n.type === "array" && !isObject(n.items)) {
			out.push(`${who}: ${path} is an array without items`);
		}
		if (rules.allowedKeywords !== undefined) {
			for (const k of Object.keys(n)) {
				if (!rules.allowedKeywords.has(k)) {
					out.push(`${who}: ${path} uses keyword ${k} the client cannot take`);
				}
			}
		}
	});
	if (rules.keepsRequired) {
		const before = JSON.stringify(requiredOf(published));
		const after = JSON.stringify(requiredOf(sent));
		if (before !== after)
			out.push(`${who}: required changed (${before} -> ${after})`);
	}
	if (rules.mustStayValid) {
		// Without $schema Ajv checks against draft-07, the dialect Gemini's
		// OpenAPI-style schema is closest to.
		if (!ajv.validateSchema(sent)) {
			out.push(`${who}: not valid JSON Schema: ${ajv.errorsText(ajv.errors)}`);
		} else {
			try {
				ajv.compile(sent);
			} catch (err) {
				out.push(`${who}: schema does not compile: ${String(err)}`);
			}
		}
	}
	return out;
}

const ajv2020 = new Ajv2020({ strict: true });
addFormats(ajv2020);

/** The published schema as draft 2020-12 (what Claude Code and OpenCode pass on). */
export function validDraft2020(schema: JsonObject): string[] {
	return ajv2020.validateSchema(schema)
		? []
		: [ajv2020.errorsText(ajv2020.errors)];
}

// Response conformance against the committed OpenAPI document: the status,
// content type and body of a JSON response must be described by the
// operation (S7 §15.1). Schemas are validated with ajv (JSON Schema 2020-12,
// the dialect of OpenAPI 3.1) and ajv-formats.
//
// Strict: response objects may not carry undocumented fields. The document
// leaves objects open (clients must ignore new fields, §5.9), so before
// compiling, every object schema without `additionalProperties` gets
// `unevaluatedProperties: false` (see `strictCopy`). A leaked field
// (`request`, `bodyHash`) fails the test.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS: its default export arrives wrapped.
const addFormats =
	addFormatsModule as unknown as typeof addFormatsModule.default;

export interface OpenApiDoc {
	paths: Record<string, Record<string, OperationObject>>;
	components?: { schemas?: Record<string, unknown> };
}

interface OperationObject {
	operationId?: string;
	responses?: Record<
		string,
		{ content?: Record<string, { schema?: unknown }> }
	>;
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

/** Finds the document path template ("/v1/sandboxes/{sandbox}") of a concrete path. */
export function matchPath(doc: OpenApiDoc, path: string): string | null {
	const bare = path.split("?")[0] ?? path;
	for (const template of Object.keys(doc.paths)) {
		const re = new RegExp(
			`^${template
				.split(/\{[^}]+\}/)
				.map((s) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
				.join("[^/]+")}$`,
		);
		if (re.test(bare)) return template;
	}
	return null;
}

const ajvByDoc = new WeakMap<OpenApiDoc, Ajv2020>();
const compiled = new WeakMap<OpenApiDoc, Map<string, ValidateFunction>>();

function ajvFor(doc: OpenApiDoc): Ajv2020 {
	let ajv = ajvByDoc.get(doc);
	if (!ajv) {
		// strict: false — OpenAPI keywords (discriminator, example, x-*) are
		// annotations for this check.
		ajv = new Ajv2020({ strict: false, allErrors: true });
		addFormats(ajv);
		// The whole document under one id, so "#/components/..." refs resolve.
		ajv.addSchema(strictCopy(doc), "openapi");
		ajvByDoc.set(doc, ajv);
	}
	return ajv;
}

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node =>
	v !== null && typeof v === "object" && !Array.isArray(v);

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs"];
const SCHEMA_ONE = [
	"items",
	"additionalProperties",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
];
const SCHEMA_LISTS = ["prefixItems", "oneOf", "anyOf"];
const COMPONENT_REF = "#/components/schemas/";

/**
 * Closes an object schema in place, then its sub-schemas. Members of `allOf`
 * stay open (each sees only its own properties); the schema holding the
 * `allOf` is closed instead and sees the properties of all members.
 */
function closeSchema(s: unknown, inAllOf: boolean): void {
	if (!isNode(s)) return;
	const types = Array.isArray(s.type) ? s.type : [s.type];
	const objectLike =
		types.includes("object") || "properties" in s || "allOf" in s;
	if (
		objectLike &&
		!inAllOf &&
		!("additionalProperties" in s) &&
		!("unevaluatedProperties" in s)
	) {
		s.unevaluatedProperties = false;
	}
	for (const k of SCHEMA_MAPS) {
		const m = s[k];
		if (isNode(m)) for (const v of Object.values(m)) closeSchema(v, false);
	}
	for (const k of SCHEMA_ONE) closeSchema(s[k], false);
	for (const k of SCHEMA_LISTS) {
		const l = s[k];
		if (Array.isArray(l)) for (const v of l) closeSchema(v, false);
	}
	if (Array.isArray(s.allOf)) for (const v of s.allOf) closeSchema(v, true);
}

/** Names of components used as `allOf` members: they must stay open. */
function allOfComponents(v: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(v)) {
		for (const x of v) allOfComponents(x, out);
	} else if (isNode(v)) {
		if (Array.isArray(v.allOf)) {
			for (const m of v.allOf) {
				const ref = isNode(m) ? m.$ref : undefined;
				if (typeof ref === "string" && ref.startsWith(COMPONENT_REF)) {
					out.add(ref.slice(COMPONENT_REF.length));
				}
			}
		}
		for (const x of Object.values(v)) allOfComponents(x, out);
	}
	return out;
}

/** A copy of the document with closed response and component schemas. */
export function strictCopy(doc: OpenApiDoc): OpenApiDoc {
	const copy = structuredClone(doc);
	const open = allOfComponents(copy);
	for (const [name, s] of Object.entries(copy.components?.schemas ?? {})) {
		closeSchema(s, open.has(name));
	}
	for (const item of Object.values(copy.paths)) {
		for (const op of Object.values(item)) {
			if (!isNode(op) || !isNode(op.responses)) continue;
			for (const r of Object.values(op.responses)) {
				const content = isNode(r) ? r.content : undefined;
				if (!isNode(content)) continue;
				for (const media of Object.values(content)) {
					if (isNode(media)) closeSchema(media.schema, false);
				}
			}
		}
	}
	return copy;
}

function pointer(...parts: string[]): string {
	return parts
		.map((p) =>
			encodeURIComponent(p.replaceAll("~", "~0").replaceAll("/", "~1")),
		)
		.join("/");
}

function validator(doc: OpenApiDoc, ref: string): ValidateFunction {
	let byRef = compiled.get(doc);
	if (!byRef) {
		byRef = new Map();
		compiled.set(doc, byRef);
	}
	let v = byRef.get(ref);
	if (!v) {
		v = ajvFor(doc).compile({ $ref: `openapi#/${ref}` });
		byRef.set(ref, v);
	}
	return v;
}

/** Result of a conformance check: which operation the response belongs to. */
export interface Conformance {
	/** `operationId`, or null for an error of a path the document does not have. */
	operationId: string | null;
}

/**
 * Throws unless the response is described by the document. An error status
 * (>= 400) on a path or method the document does not have (unknown route,
 * 405) must match `components.schemas.Error`.
 */
export function assertConforms(
	doc: OpenApiDoc,
	method: string,
	path: string,
	status: number,
	contentType: string,
	body: unknown,
): Conformance {
	const m = method.toLowerCase();
	const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	const template = matchPath(doc, path);
	const op =
		template !== null && METHODS.includes(m)
			? doc.paths[template]?.[m]
			: undefined;
	const where = `${method.toUpperCase()} ${path} -> ${status} ${mediaType}`;

	let ref: string;
	let operationId: string | null = null;
	if (!op || template === null) {
		if (status < 400) throw new Error(`${where}: undocumented operation`);
		if (!doc.components?.schemas?.Error) {
			throw new Error(`${where}: the document has no Error schema`);
		}
		ref = pointer("components", "schemas", "Error");
	} else {
		operationId = op.operationId ?? null;
		const responses = op.responses ?? {};
		const key = [String(status), `${String(status)[0]}XX`, "default"].find(
			(k) => responses[k] !== undefined,
		);
		if (key === undefined) {
			throw new Error(
				`${where}: status not documented (has ${Object.keys(responses).join(", ")})`,
			);
		}
		const content = responses[key]?.content ?? {};
		if (content[mediaType]?.schema === undefined) {
			throw new Error(
				`${where}: content type not documented (has ${Object.keys(content).join(", ") || "none"})`,
			);
		}
		ref = pointer(
			"paths",
			template,
			m,
			"responses",
			key,
			"content",
			mediaType,
			"schema",
		);
	}

	const v = validator(doc, ref);
	if (!v(body)) {
		const errs = (v.errors ?? [])
			.map((e) => `  ${e.instancePath || "/"} ${e.message ?? ""}`)
			.join("\n");
		throw new Error(
			`${where}: body does not match the schema:\n${errs}\nbody: ${JSON.stringify(body).slice(0, 2000)}`,
		);
	}
	return { operationId };
}

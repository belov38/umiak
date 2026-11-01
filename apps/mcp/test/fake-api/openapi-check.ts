// Contract check of the fake API: every request and response is validated
// against apps/api/openapi/v1.json, including S10, so the fake cannot drift
// from the real API.
//
// Choices:
//   - Ajv 2020 with ajv-formats; `$ref`s are resolved by Ajv from one merged
//     document; OpenAPI-only keywords (`example`, `x-extensible-enum`, ...)
//     are ignored.
//   - Enums stay strict: `x-extensible-enum` is the API telling *clients* to
//     accept unknown values, while the fake must only ever send known ones,
//     which catches typos and drift.
//   - Request: path and query parameters (coerced from strings), declared
//     header parameters and the JSON body. Unknown query parameters are
//     reported too: the real API ignores them silently, so a typo in the MCP
//     code would never fail anywhere else.
//   - Response: status (or `default`), content type, JSON body, declared
//     headers. NDJSON frames are validated one by one where the fake writes
//     them (`validateFrame`).
//
// Nothing here throws on a mismatch: callers push the messages to
// `contractErrors`.
import { readFileSync } from "node:fs";
import AjvModule, { type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats are CommonJS: under NodeNext the default import is the
// module object and `.default` the class (also true at runtime).
const Ajv2020 = AjvModule.default;
type Ajv2020 = InstanceType<typeof Ajv2020>;
const addFormats = addFormatsModule.default;

type Json = Record<string, unknown>;

const V1_URL = new URL("../../../api/openapi/v1.json", import.meta.url);
const METHODS = ["get", "put", "post", "delete", "patch", "head"] as const;

/** Response headers that the real API always sends (v1.json lacks `required`). */
const ALWAYS_HEADERS: Record<string, string[]> = {
	"commands.output": ["Sbx-Offset", "Sbx-Next-Offset", "Sbx-Available-From"],
};

export interface MatchedOperation {
	operationId: string;
	method: string;
	template: string;
	operation: Json;
	params: Record<string, string>;
}

interface Route extends Omit<MatchedOperation, "params"> {
	re: RegExp;
	literalSegments: number;
}

function readJson(url: URL): Json {
	return JSON.parse(readFileSync(url, "utf8")) as Json;
}

function obj(v: unknown): Json {
	return (v ?? {}) as Json;
}

/** The public API document is the sole contract, including desktop routes. */
export function loadContract(): Json {
	return structuredClone(readJson(V1_URL));
}

function pointer(...tokens: string[]): string {
	return `#/${tokens
		.map((t) =>
			encodeURIComponent(t.replaceAll("~", "~0").replaceAll("/", "~1")),
		)
		.join("/")}`;
}

function typesOf(schema: Json): string[] {
	const t = schema.type;
	const own = Array.isArray(t)
		? (t as string[])
		: typeof t === "string"
			? [t]
			: [];
	const sub = Array.isArray(schema.anyOf)
		? (schema.anyOf as Json[]).flatMap(typesOf)
		: [];
	return [...own, ...sub];
}

/** Query/path/header strings to the JSON type the parameter schema asks for. */
function coerce(schema: Json, values: string[]): unknown {
	const types = typesOf(schema);
	if (
		types.includes("array") &&
		(values.length > 1 || !types.includes("string"))
	) {
		return values;
	}
	const v = values.length > 1 ? values : values[0];
	if (
		typeof v === "string" &&
		(types.includes("integer") || types.includes("number")) &&
		/^-?\d+(\.\d+)?$/.test(v)
	) {
		return Number(v);
	}
	return v;
}

function describe(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.slice(0, 5)
		.map((e) => {
			const where = e.instancePath === "" ? "/" : e.instancePath;
			const p = e.params as Record<string, unknown>;
			const extra =
				"allowedValues" in p
					? ` (${JSON.stringify(p.allowedValues)})`
					: "additionalProperty" in p
						? ` (${String(p.additionalProperty)})`
						: "missingProperty" in p
							? ` (${String(p.missingProperty)})`
							: "";
			return `${where} ${e.message ?? "invalid"}${extra}`;
		})
		.join("; ");
}

export class Contract {
	readonly #doc: Json;
	readonly #ajv: Ajv2020;
	readonly #routes: Route[] = [];
	readonly #compiled = new Map<string, ReturnType<Ajv2020["compile"]>>();

	constructor() {
		this.#doc = loadContract();
		this.#ajv = new Ajv2020({ strict: false, allErrors: true });
		addFormats(this.#ajv);
		this.#ajv.addFormat("binary", true);
		this.#ajv.addSchema(this.#doc, "contract");
		for (const [template, item] of Object.entries(obj(this.#doc.paths))) {
			for (const method of METHODS) {
				const operation = obj(item)[method] as Json | undefined;
				if (!operation) continue;
				const re = new RegExp(
					`^${template
						.split("/")
						.map((s) =>
							/^\{.+\}$/.test(s)
								? "([^/]+)"
								: s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
						)
						.join("/")}$`,
				);
				this.#routes.push({
					operationId: String(operation.operationId ?? `${method} ${template}`),
					method: method.toUpperCase(),
					template,
					operation,
					re,
					literalSegments: template
						.split("/")
						.filter((s) => s !== "" && !s.startsWith("{")).length,
				});
			}
		}
		// A literal path (`/api-keys/self`) wins over a templated one.
		this.#routes.sort((a, b) => b.literalSegments - a.literalSegments);
	}

	/** The operation of a request, null for a path the document does not have. */
	match(method: string, path: string): MatchedOperation | null {
		for (const r of this.#routes) {
			if (r.method !== method) continue;
			const m = r.re.exec(path);
			if (!m) continue;
			const names = [...r.template.matchAll(/\{([^}]+)\}/g)].map(
				(x) => x[1] as string,
			);
			const params: Record<string, string> = {};
			names.forEach((n, i) => {
				try {
					params[n] = decodeURIComponent(m[i + 1] as string);
				} catch {
					params[n] = m[i + 1] as string;
				}
			});
			const { re: _re, literalSegments: _l, ...op } = r;
			return { ...op, params };
		}
		return null;
	}

	#validator(...tokens: string[]) {
		const key = pointer(...tokens);
		let v = this.#compiled.get(key);
		if (!v) {
			v = this.#ajv.getSchema(`contract${key}`);
			if (!v) throw new Error(`no schema at ${key}`);
			this.#compiled.set(key, v);
		}
		return v;
	}

	/** Messages for a request that does not fit the operation; [] when fine. */
	validateRequest(
		m: MatchedOperation,
		input: {
			query: URLSearchParams;
			headers: Headers;
			/** Parsed JSON body; `present: false` when the request had none. */
			body: { present: boolean; value?: unknown };
		},
	): string[] {
		const out: string[] = [];
		const where = `${m.method} ${m.template}`;
		const known = new Set<string>();
		const params = (m.operation.parameters ?? []) as Json[];
		params.forEach((p, i) => {
			const name = String(p.name);
			const schema = obj(p.schema);
			let raw: string[] = [];
			if (p.in === "path")
				raw = m.params[name] === undefined ? [] : [m.params[name]];
			else if (p.in === "query") {
				known.add(name);
				raw = input.query.getAll(name);
			} else if (p.in === "header") {
				const h = input.headers.get(name);
				raw = h === null ? [] : [h];
			}
			if (raw.length === 0) {
				if (p.required === true && p.in !== "path")
					out.push(`${where}: missing ${String(p.in)} parameter ${name}`);
				return;
			}
			const validate = this.#validator(
				"paths",
				m.template,
				m.method.toLowerCase(),
				"parameters",
				String(i),
				"schema",
			);
			if (!validate(coerce(schema, raw))) {
				out.push(
					`${where}: ${String(p.in)} parameter ${name}: ${describe(validate.errors)}`,
				);
			}
		});
		for (const name of new Set(input.query.keys())) {
			if (!known.has(name))
				out.push(`${where}: unknown query parameter ${name}`);
		}
		const body = obj(m.operation.requestBody);
		const json = obj(obj(body.content)["application/json"]);
		if (json.schema) {
			if (!input.body.present) {
				if (body.required === true)
					out.push(`${where}: the JSON body is required`);
			} else {
				const validate = this.#validator(
					"paths",
					m.template,
					m.method.toLowerCase(),
					"requestBody",
					"content",
					"application/json",
					"schema",
				);
				if (!validate(input.body.value))
					out.push(`${where}: body: ${describe(validate.errors)}`);
			}
		} else if (input.body.present && !body.content) {
			out.push(`${where}: the operation takes no body`);
		}
		return out;
	}

	/** Messages for a response that does not fit the operation; [] when fine. */
	validateResponse(
		m: MatchedOperation | null,
		input: {
			status: number;
			headers: Headers;
			/** Parsed body of an `application/json` response. */
			json?: unknown;
		},
	): string[] {
		const out: string[] = [];
		const ct =
			(input.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
		if (m === null) {
			// A path outside the document: only the error envelope is checkable.
			if (ct === "application/json") {
				const v = this.#validator("components", "schemas", "Error");
				if (!v(input.json))
					out.push(`unrouted ${input.status}: ${describe(v.errors)}`);
			}
			return out;
		}
		const where = `${m.method} ${m.template} -> ${input.status}`;
		const responses = obj(m.operation.responses);
		const key =
			String(input.status) in responses ? String(input.status) : "default";
		const spec = responses[key] as Json | undefined;
		if (!spec) return [`${where}: status not declared and no default`];
		const content = obj(spec.content);
		if (ct !== "") {
			if (!(ct in content)) {
				out.push(
					`${where}: content type ${ct} not declared (${Object.keys(content).join(", ") || "none"})`,
				);
			} else if (ct === "application/json") {
				const v = this.#validator(
					"paths",
					m.template,
					m.method.toLowerCase(),
					"responses",
					key,
					"content",
					"application/json",
					"schema",
				);
				if (!v(input.json)) out.push(`${where}: body: ${describe(v.errors)}`);
			}
		} else if (Object.keys(content).length > 0 && input.status !== 204) {
			out.push(
				`${where}: no content type, the document declares ${Object.keys(content).join(", ")}`,
			);
		}
		const headers = obj(spec.headers);
		for (const [name, h] of Object.entries(headers)) {
			const raw = input.headers.get(name);
			if (raw === null) {
				if (obj(h).required === true)
					out.push(`${where}: missing header ${name}`);
				continue;
			}
			const schema = obj(obj(h).schema);
			const v = this.#ajv.compile(schema);
			if (!v(coerce(schema, [raw])))
				out.push(`${where}: header ${name}=${raw}: ${describe(v.errors)}`);
		}
		for (const name of ALWAYS_HEADERS[m.operationId] ?? []) {
			if (input.status === 200 && input.headers.get(name) === null) {
				out.push(`${where}: missing header ${name}`);
			}
		}
		return out;
	}

	/** Messages for an NDJSON command frame that is not a CommandFrame. */
	validateFrame(frame: unknown): string[] {
		const v = this.#validator("components", "schemas", "CommandFrame");
		return v(frame)
			? []
			: [
					`command frame ${JSON.stringify(frame).slice(0, 120)}: ${describe(v.errors)}`,
				];
	}
}

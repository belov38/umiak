// Global setup of OpenAPI conformance coverage (S7 §16 "Контракт"): every
// operation of `openapi/v1.json` must have at least one JSON response that
// passed the strict conformance check of the harness during a full run of
// the apps/api tests. Operations whose success answers are not JSON need a
// validated (error) answer instead; operations that never answer with a
// JSON body are listed in NO_JSON_BODY.
//
// Each test file writes its counts (conformance-setup.ts); the teardown
// checks them only when every test file reported and no name filter was
// given, so a run of one file does not fail on coverage.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import type { CoverageRecord, OperationCount } from "./conformance-coverage.ts";

/**
 * Operations without a JSON (or NDJSON) success answer in the document: raw
 * file content, archives, 204s and the WebSocket upgrade. They are covered
 * by their validated error answers. Must equal the document's set.
 */
export const NON_JSON_SUCCESS = [
	"desktop.endStreams",
	"desktop.screenshot",
	"desktop.setClipboard",
	"apiKeys.revoke",
	"apiKeys.revokeSelf",
	"commands.input",
	"commands.output",
	"environments.delete",
	"files.deleteUpload",
	"files.download",
	"files.downloadArchive",
	"files.downloadHead",
	"files.uploadOffset",
	"meta.docs",
	"ports.delete",
	"ptys.connect",
	"ptys.resize",
	"snapshots.delete",
	"sshKeys.delete",
];

/**
 * Operations that never answer with a JSON body, so nothing of theirs can
 * be validated: HEAD answers (errors included) have no body, and the API
 * reference page is HTML without an error path.
 */
export const NO_JSON_BODY = [
	"files.downloadHead",
	"files.uploadOffset",
	"meta.docs",
];

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const JSON_TYPE = /^application\/((.+\+)?json|x-ndjson)$/i;

interface DocOperation {
	responses?: Record<string, { content?: Record<string, unknown> }>;
	operationId?: string;
}

/** operationId → whether a success answer of it has a JSON body. */
export function documentOperations(doc: {
	paths: Record<string, Record<string, unknown>>;
}): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const item of Object.values(doc.paths)) {
		for (const [method, raw] of Object.entries(item)) {
			if (!METHODS.includes(method)) continue;
			const op = raw as DocOperation;
			if (op.operationId === undefined) continue;
			const json = Object.entries(op.responses ?? {}).some(
				([status, r]) =>
					/^[123]/.test(status) &&
					Object.keys(r.content ?? {}).some((t) => JSON_TYPE.test(t)),
			);
			out.set(op.operationId, json);
		}
	}
	return out;
}

/** Problems of the coverage; empty when every operation is covered. */
export function coverageProblems(
	ops: Map<string, boolean>,
	counts: Map<string, OperationCount>,
): string[] {
	const problems: string[] = [];
	const nonJson = [...ops].filter(([, json]) => !json).map(([id]) => id);
	const listed = new Set(NON_JSON_SUCCESS);
	for (const id of nonJson) {
		if (!listed.has(id)) {
			problems.push(
				`${id} has no JSON success answer: add it to NON_JSON_SUCCESS`,
			);
		}
	}
	for (const id of listed) {
		if (ops.get(id) !== false) {
			problems.push(
				`${id} is in NON_JSON_SUCCESS but the document has no such operation without a JSON success answer`,
			);
		}
	}
	for (const id of NO_JSON_BODY) {
		if (!listed.has(id)) problems.push(`${id} must be in NON_JSON_SUCCESS`);
	}
	for (const [id, json] of ops) {
		if (NO_JSON_BODY.includes(id)) continue;
		const c = counts.get(id) ?? { ok: 0, error: 0 };
		if (json && c.ok === 0) {
			problems.push(`${id}: no success answer was validated`);
		} else if (!json && c.ok + c.error === 0) {
			problems.push(`${id}: no answer was validated`);
		}
	}
	return problems;
}

function testFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".test.ts"))
		.map((f) => join(dir, f));
}

let dir = "";
let root = "";
let filtered = false;

export function setup(project: TestProject): void {
	root = project.config.root;
	filtered =
		project.config.testNamePattern !== undefined ||
		(process.env.UMIAK_TEST_SKIP_PG === "1" &&
			!process.env.UMIAK_TEST_DATABASE_URL);
	dir = mkdtempSync(join(tmpdir(), "umiak-conformance-"));
	project.provide("umiakConformanceDir", dir);
}

export function teardown(): void {
	if (dir === "") return;
	try {
		const records = readdirSync(dir).map(
			(f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as CoverageRecord,
		);
		const reported = new Set(records.map((r) => r.file));
		const all = testFiles(join(root, "test"));
		if (filtered || !all.every((f) => reported.has(f))) return;
		const counts = new Map<string, OperationCount>();
		for (const r of records) {
			for (const [id, c] of Object.entries(r.operations)) {
				const sum = counts.get(id) ?? { ok: 0, error: 0 };
				sum.ok += c.ok;
				sum.error += c.error;
				counts.set(id, sum);
			}
		}
		const doc = JSON.parse(
			readFileSync(join(root, "openapi", "v1.json"), "utf8"),
		);
		const problems = coverageProblems(documentOperations(doc), counts);
		if (problems.length > 0) {
			throw new Error(
				`OpenAPI conformance coverage: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		dir = "";
	}
}

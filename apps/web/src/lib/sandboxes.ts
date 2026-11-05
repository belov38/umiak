// The sandbox list (S8 §9.4) without the DOM: filters and state classes.
import type { SandboxData } from "@umiak/sdk";

export type SandboxState = SandboxData["state"];

/** The list refreshes this often while the tab is visible (S8 §9.4). */
export const POLL_MS = 5_000;
/** A poll fails fast when the API is away instead of retrying for a minute. */
export const POLL_RETRY_BUDGET_MS = 2_000;

/** States shown with a spinner and the step of the active operation. */
export const TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
	"creating",
	"moving",
	"queued",
	"starting",
	"stopping",
	"deleting",
]);

/** The state filter of the list ("deleted" is never listed). */
export const STATE_FILTERS = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
] as const;

/**
 * `k=v` pairs separated by commas or spaces → labels that must all match;
 * a pair without `=` or with an empty key is an error.
 */
export function parseLabelFilter(
	text: string,
): { ok: true; labels: Record<string, string> } | { ok: false; error: string } {
	const labels: Record<string, string> = {};
	for (const part of text.split(/[\s,]+/)) {
		if (part === "") continue;
		const eq = part.indexOf("=");
		if (eq <= 0) return { ok: false, error: `Use key=value: "${part}"` };
		labels[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return { ok: true, labels };
}

export interface ListFilter {
	q: string;
	state: SandboxState | "all";
	labels: Record<string, string>;
}

/** Query of GET /v1/sandboxes for one page. */
export function listQuery(
	f: ListFilter,
	cursor: string | undefined,
	limit = 50,
): {
	q?: string;
	state?: string;
	label?: string[];
	limit: number;
	cursor?: string;
} {
	const label = Object.entries(f.labels).map(([k, v]) => `${k}=${v}`);
	const q = f.q.trim();
	return {
		...(q === "" ? {} : { q }),
		...(f.state === "all" ? {} : { state: f.state }),
		...(label.length === 0 ? {} : { label }),
		limit,
		...(cursor === undefined ? {} : { cursor }),
	};
}

/** Stop is offered for a ready sandbox. */
export function canStop(s: SandboxData): boolean {
	return s.state === "ready";
}

/** Resume: stopped, not blocked. */
export function canResume(s: SandboxData): boolean {
	return s.state === "stopped" && !s.blocked;
}

/** Fork: ready or stopped, not blocked. */
export function canFork(s: SandboxData): boolean {
	return (s.state === "ready" || s.state === "stopped") && !s.blocked;
}

/** Anything not already going away can be deleted. */
export function canDelete(s: SandboxData): boolean {
	return s.state !== "deleting" && s.state !== "deleted";
}

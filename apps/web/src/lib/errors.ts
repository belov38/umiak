// API error → text of the dashboard (S8 §9.5, S7 §5.5, §23.2). The codes
// the user can act on get their own words; anything else shows the API's
// message, which is written for people too. Pure: no DOM, no toast.
import { NETWORK_ERROR, SbxError, UNEXPECTED_RESPONSE } from "@sbx/sdk";

export interface ErrorView {
	/** The API code, or null for something that is not an API error. */
	code: string | null;
	message: string;
	/** Trying the same thing again later may work (show a retry). */
	retry: boolean;
	/** The API is not reachable at all (S8 §13: "API unavailable"). */
	apiUnavailable: boolean;
}

/** Errors of POST /v1/sandboxes that §9.5 wants as plain text at the form. */
export const CREATE_ERROR_CODES = [
	"quota_exceeded",
	"out_of_capacity",
	"slug_taken",
	"template_unavailable",
] as const;

export const GENERIC_ERROR =
	"Something went wrong. Try again; if it keeps failing, reload the page.";

export const API_UNAVAILABLE =
	"The API is unavailable right now. The page keeps trying; check back in a moment.";

const QUOTA_NAMES: Record<string, string> = {
	active_sandboxes: "active sandboxes",
	activeSandboxes: "active sandboxes",
	maxActiveSandboxes: "active sandboxes",
	ram_mb: "RAM (MB)",
	ramMb: "RAM (MB)",
	maxRamMb: "RAM (MB)",
	saved_snapshots: "saved snapshots",
	savedSnapshots: "saved snapshots",
	maxSavedSnapshots: "saved snapshots",
};

function isSbxError(e: unknown): e is SbxError {
	return (
		e instanceof SbxError ||
		(e instanceof Error &&
			e.name === "SbxError" &&
			typeof (e as { code?: unknown }).code === "string")
	);
}

/** No answer from the API: network, a proxy page instead of the API, or a pod going away. */
export function isApiUnavailable(e: unknown): boolean {
	if (!isSbxError(e)) return false;
	if (e.code === NETWORK_ERROR) return true;
	if (e.code === UNEXPECTED_RESPONSE) {
		return e.status === 502 || e.status === 503 || e.status === 504;
	}
	return e.code === "server_shutting_down" || e.code === "not_ready";
}

function str(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}

function quotaText(d: Record<string, unknown>): string {
	const q = str(d.quota);
	const name = q === null ? "the team's quota" : (QUOTA_NAMES[q] ?? q);
	const limit = typeof d.limit === "number" ? d.limit : null;
	const current = typeof d.current === "number" ? d.current : null;
	const numbers =
		limit === null
			? ""
			: ` (limit ${limit}${current === null ? "" : `, in use ${current}`})`;
	return `The team's quota is used up: ${name}${numbers}. Stop or delete a sandbox, or ask a platform operator for a bigger quota.`;
}

function issuesText(d: Record<string, unknown>, fallback: string): string {
	const issues = Array.isArray(d.issues) ? d.issues : [];
	const lines = issues
		.map((i) => {
			if (!i || typeof i !== "object") return null;
			const r = i as Record<string, unknown>;
			const msg = str(r.message);
			if (msg === null) return null;
			const path = str(r.path);
			return path === null ? msg : `${path}: ${msg}`;
		})
		.filter((l): l is string => l !== null);
	return lines.length === 0
		? fallback
		: `Some fields are not valid: ${lines.join("; ")}.`;
}

function forbiddenText(e: SbxError): string {
	switch (str(e.details.reason)) {
		case "sandbox_blocked":
			return "A platform operator blocked this sandbox: only reading, stop and delete work.";
		case "port_blocked":
			return "A platform operator blocked this port.";
		case "role":
			return "Only an owner of the team can do this.";
		case "user_required":
			return "Only a person signed in to the dashboard can do this.";
		case "user_disabled":
			return "Your account is deactivated.";
		default:
			return e.message;
	}
}

function textOf(e: SbxError): { message: string; retry?: boolean } {
	const d = e.details;
	switch (e.code) {
		case "quota_exceeded":
			return { message: quotaText(d) };
		case "out_of_capacity":
			return {
				message:
					"No server has enough free memory for this size right now, and nothing was created. Try again in a minute, or pick a smaller size.",
				retry: true,
			};
		case "slug_taken":
			return {
				message:
					"Another sandbox of the team already has this slug. Pick another one, or leave the slug empty for three random words.",
			};
		case "template_unavailable":
			return {
				message:
					"This template or size cannot be used now: a platform operator disabled it, or the size is not allowed for the template. Pick another one.",
			};
		case "snapshot_not_found":
			return { message: "The saved snapshot does not exist anymore." };
		case "snapshot_name_taken":
			return { message: "A saved snapshot with this name already exists." };
		case "validation":
			return { message: issuesText(d, e.message) };
		case "forbidden":
			return { message: forbiddenText(e) };
		case "team_forbidden":
			return { message: "You are not a member of this team." };
		case "unauthorized":
		case "token_expired":
			return {
				message: "Your session has ended. Reload the page to sign in again.",
			};
		case "not_found":
			return { message: "Not found: it may have been deleted meanwhile." };
		case "operation_in_progress": {
			const kind = str(d.kind);
			return {
				message: `Another operation${kind ? ` (${kind})` : ""} is running on this sandbox. Try again when it finishes.`,
				retry: true,
			};
		}
		case "invalid_state": {
			const state = str(d.state);
			return {
				message: `Not possible in the current state${state ? ` (${state})` : ""}.`,
			};
		}
		case "rate_limited":
			return {
				message: "Too many requests. Wait a moment and try again.",
				retry: true,
			};
		default:
			return { message: e.message || GENERIC_ERROR };
	}
}

/** What to tell the user about `e`. */
export function describeError(e: unknown): ErrorView {
	if (!isSbxError(e)) {
		return {
			code: null,
			message: GENERIC_ERROR,
			retry: false,
			apiUnavailable: false,
		};
	}
	if (isApiUnavailable(e)) {
		return {
			code: e.code,
			message: API_UNAVAILABLE,
			retry: true,
			apiUnavailable: true,
		};
	}
	const t = textOf(e);
	return {
		code: e.code,
		message: t.message,
		retry: t.retry ?? false,
		apiUnavailable: false,
	};
}

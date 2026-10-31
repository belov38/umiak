// "Delete team" of /admin (S8 §6.4, plan decision 12) without the DOM. web
// has no access to the runtime, so the operator's browser asks the api
// whether the team still has sandboxes, saved snapshots or environments,
// and only then deletes the team through Payload REST. A sandbox created
// between the check and the delete is a known, harmless race (§6.4).

/**
 * Payload refuses a team delete without this header (teams access in
 * @sbx/payload), so the admin's own Delete never shows and the check below
 * cannot be skipped by accident.
 */
export const DELETE_TEAM_HEADER = "x-sbx-delete-team";

export interface TeamContents {
	/** 0 or 1: the list is read with limit=1. */
	sandboxes: number;
	snapshots: number;
	environments: number;
}

type Fetch = typeof fetch;

async function errorText(r: Response): Promise<string> {
	try {
		const body = (await r.json()) as {
			error?: { message?: unknown };
			errors?: { message?: unknown }[];
		};
		const m = body.error?.message ?? body.errors?.[0]?.message;
		if (typeof m === "string" && m !== "") return m;
	} catch {
		// Not JSON: a proxy page.
	}
	return `HTTP ${r.status}`;
}

async function apiList(
	f: Fetch,
	path: string,
	teamId: string,
): Promise<number> {
	const r = await f(path, {
		method: "GET",
		credentials: "same-origin",
		headers: { Accept: "application/json", "Sbx-Team": teamId },
	});
	if (!r.ok) throw new Error(`${path.split("?")[0]}: ${await errorText(r)}`);
	const body = (await r.json()) as { data?: unknown };
	if (!Array.isArray(body.data)) {
		throw new Error(`${path.split("?")[0]}: unexpected answer`);
	}
	return body.data.length;
}

/** What the team still has, from the api with `Sbx-Team` of the team. */
export async function teamContents(
	f: Fetch,
	teamId: string,
): Promise<TeamContents> {
	const q = new URLSearchParams({ allTeams: "true", teamId, limit: "1" });
	const [sandboxes, snapshots, environments] = await Promise.all([
		apiList(f, `/api/v1/sandboxes?${q}`, teamId),
		apiList(f, "/api/v1/snapshots", teamId),
		apiList(f, "/api/v1/environments", teamId),
	]);
	return { sandboxes, snapshots, environments };
}

function plural(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Why the team cannot be deleted yet, or null when it is empty. */
export function refusalText(c: TeamContents): string | null {
	const left: string[] = [];
	if (c.sandboxes > 0) left.push("sandboxes");
	if (c.snapshots > 0) left.push(plural(c.snapshots, "saved snapshot"));
	if (c.environments > 0) left.push(plural(c.environments, "environment"));
	if (left.length === 0) return null;
	return `The team still has ${left.join(", ")}. Delete them first (sandboxes in the Operator section of /app, snapshots and environments on the team's pages), then try again.`;
}

const PAYLOAD_ERRORS: Record<string, string> = {
	personal_team: "A personal team cannot be deleted.",
};

/** DELETE /cms-api/teams/<uuid>; the hooks remove memberships and revoke keys. */
export async function deleteTeam(f: Fetch, uuid: string): Promise<void> {
	const r = await f(`/cms-api/teams/${encodeURIComponent(uuid)}`, {
		method: "DELETE",
		credentials: "same-origin",
		headers: { Accept: "application/json", [DELETE_TEAM_HEADER]: "checked" },
	});
	if (r.ok) return;
	const m = await errorText(r);
	throw new Error(PAYLOAD_ERRORS[m] ?? m);
}

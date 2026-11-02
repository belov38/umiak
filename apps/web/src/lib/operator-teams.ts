// Every team for the operator page (S8 §9.10): Payload rows → public ids
// and names for the team column and filter. Server only (the id codec of
// @umiak/auth comes with its Postgres store).
import { encodeUuid } from "@umiak/auth";
import type { OperatorTeam } from "./operator";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows without a UUID id are dropped; sorted by name. */
export function toOperatorTeams(
	docs: { id: unknown; name?: unknown; personal?: unknown }[],
): OperatorTeam[] {
	const out: OperatorTeam[] = [];
	for (const d of docs) {
		if (typeof d.id !== "string" || !UUID_RE.test(d.id)) continue;
		const id = encodeUuid("team", d.id);
		out.push({
			id,
			name: typeof d.name === "string" && d.name !== "" ? d.name : id,
			personal: d.personal === true,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

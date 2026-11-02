// "Delete team" on the team edit view of /admin (S8 §6.4, plan decision 12):
// rendered for saved shared teams only; the button gets the team's public
// id for the api checks and its UUID for the Payload delete.
import { encodeUuid } from "@umiak/auth";
import type { Payload } from "payload";
import { DeleteTeamButton } from "./delete-team-button";

export async function DeleteTeamControl({
	id,
	payload,
}: {
	id?: number | string;
	payload: Payload;
}) {
	if (typeof id !== "string" || id === "") return null;
	const team = await payload.findByID({
		collection: "teams",
		id,
		depth: 0,
		disableErrors: true,
	});
	if (!team || team.personal === true) return null;
	return (
		<DeleteTeamButton
			uuid={id}
			teamId={encodeUuid("team", id)}
			name={String(team.name)}
		/>
	);
}

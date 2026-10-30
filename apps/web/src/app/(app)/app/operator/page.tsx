// The operator section (S8 §9.10): operators of the session only (resolved
// on the server; anyone else gets the 403 page). Every team comes from
// Payload here, for the team column and filter of the client.
import { forbidden, unauthorized } from "next/navigation";
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { OperatorPage } from "@/features/operator/operator-page";
import { requireOperator } from "@/lib/operator";
import { toOperatorTeams } from "@/lib/operator-teams";
import { getWebPayload } from "@/lib/payload";
import { getAppSession } from "@/lib/session";

export default async function OperatorRoute() {
	const guard = requireOperator(await getAppSession());
	if (!guard.ok) {
		if (guard.status === 401) unauthorized();
		forbidden();
	}
	const payload = await getWebPayload();
	const teams = await payload.find({
		collection: "teams",
		depth: 0,
		pagination: false,
		select: { name: true, personal: true },
	});
	return (
		<DefaultTeamShell>
			<OperatorPage teams={toOperatorTeams(teams.docs)} />
		</DefaultTeamShell>
	);
}

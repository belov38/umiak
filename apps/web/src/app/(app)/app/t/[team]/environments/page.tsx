// Environments of the team (S8 §10). The names of the members come from
// Payload with the same rules as the settings page (for "updated by"); the
// environments themselves from the SDK.
import { forbidden, notFound, unauthorized } from "next/navigation";
import { EnvironmentsPage } from "@/features/environments/environments-page";
import { requestActionCtx } from "@/lib/action-context";
import { loadTeamSettingsImpl } from "@/lib/team-actions/team-settings";

export default async function TeamEnvironmentsPage({
	params,
}: {
	params: Promise<{ team: string }>;
}) {
	const { team } = await params;
	const ctx = await requestActionCtx();
	if (ctx === null) unauthorized();
	const r = await loadTeamSettingsImpl(ctx, { teamId: team });
	if ("error" in r) {
		if (r.error.code === "forbidden") forbidden();
		notFound();
	}
	const people: Record<string, string> = {};
	for (const m of r.members) people[m.userId] = m.name ?? m.email;
	return <EnvironmentsPage teamId={team} people={people} />;
}

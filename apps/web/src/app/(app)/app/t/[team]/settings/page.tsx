// Team settings (S8 §9.9). The team layout already refused non-members;
// the data is read here with the same rules as the server actions.
import { forbidden, notFound, unauthorized } from "next/navigation";
import { TeamSettings } from "@/components/app/team-settings";
import { requestActionCtx } from "@/lib/action-context";
import { loadTeamSettingsImpl } from "@/lib/team-actions/team-settings";

export default async function TeamSettingsPage({
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
	const { ok: _, ...data } = r;
	return <TeamSettings data={data} />;
}

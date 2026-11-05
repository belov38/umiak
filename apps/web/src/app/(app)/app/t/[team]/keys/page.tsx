// Team API keys: authorize team access through Payload; load keys with the SDK.
import { forbidden, notFound, unauthorized } from "next/navigation";
import { KeysPage } from "@/features/keys/keys-page";
import { requestActionCtx } from "@/lib/action-context";
import { loadTeamSettingsImpl } from "@/lib/team-actions/team-settings";

export default async function TeamKeysPage({
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
	return <KeysPage teamId={team} />;
}

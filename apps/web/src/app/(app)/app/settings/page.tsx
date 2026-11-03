import { redirect } from "next/navigation";
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { DeploymentSettings } from "@/components/app/deployment-settings";
import { getDeploymentMeta } from "@/lib/deployment-meta";
import { getAppSession } from "@/lib/session";

export default async function SettingsPage() {
	const session = await getAppSession();
	if ((await getDeploymentMeta()).tenancy !== "single")
		redirect(`/app/t/${session.defaultTeamId}/settings`);
	return (
		<DefaultTeamShell>
			<DeploymentSettings teamId={session.defaultTeamId} />
		</DefaultTeamShell>
	);
}

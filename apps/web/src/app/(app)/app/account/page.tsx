import { redirect } from "next/navigation";
// Account (S8 §9.9): SSH keys, default team, profile, sign out.
import { AccountSettings } from "@/components/app/account-settings";
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { getDeploymentMeta } from "@/lib/deployment-meta";

export default async function AccountPage() {
	if ((await getDeploymentMeta()).tenancy === "single")
		redirect("/app/settings");

	return (
		<DefaultTeamShell>
			<AccountSettings signOutHref={null} />
		</DefaultTeamShell>
	);
}

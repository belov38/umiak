// Account (S8 §9.9): SSH keys, default team, profile, sign out.
import { AccountSettings } from "@/components/app/account-settings";
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { webEnv } from "@/lib/env";
import { signOutHref } from "@/lib/team-path";

export default function AccountPage() {
	return (
		<DefaultTeamShell>
			<AccountSettings signOutHref={signOutHref(webEnv().logoutUrl)} />
		</DefaultTeamShell>
	);
}

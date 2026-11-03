// The /app frame for pages outside a team (account, new team): the
// default team is the current one in the switcher.
import type React from "react";
import { AppShell } from "@/components/app/app-shell";
import { webEnv } from "@/lib/env";
import { getAppSession } from "@/lib/session";

export async function DefaultTeamShell({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getAppSession();
	const team = session.teams.find((t) => t.id === session.defaultTeamId);
	if (team === undefined) {
		return <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>;
	}
	return (
		<AppShell
			quickstart={process.env.UMIAK_QUICKSTART === "1"}
			team={team}
			member
			logoutUrl={webEnv().logoutUrl}
			localMode={webEnv().authMode === "none"}
		>
			{children}
		</AppShell>
	);
}

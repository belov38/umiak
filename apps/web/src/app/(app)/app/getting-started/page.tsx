import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { GettingStarted } from "@/features/getting-started/getting-started";
import { webEnv } from "@/lib/env";

export default function GettingStartedPage() {
	const env = webEnv();
	return (
		<DefaultTeamShell>
			<GettingStarted
				deployment={{
					mode: process.env.UMIAK_QUICKSTART === "1" ? "owner" : env.authMode,
					apiUrl: env.apiPublicUrl,
					appUrl: env.appOrigin,
					previewDomain: env.umiakDomain,
				}}
			/>
		</DefaultTeamShell>
	);
}

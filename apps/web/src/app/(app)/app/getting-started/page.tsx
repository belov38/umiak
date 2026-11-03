import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { GettingStarted } from "@/features/getting-started/getting-started";
import { getDeploymentMeta } from "@/lib/deployment-meta";
import { webEnv } from "@/lib/env";

export default async function GettingStartedPage() {
	const env = webEnv();
	const { tenancy } = await getDeploymentMeta();
	return (
		<DefaultTeamShell>
			<GettingStarted
				deployment={{
					tenancy,
					mode: process.env.UMIAK_QUICKSTART === "1" ? "owner" : env.authMode,
					apiUrl: env.apiPublicUrl,
					appUrl: env.appOrigin,
					previewDomain: env.umiakDomain,
				}}
			/>
		</DefaultTeamShell>
	);
}

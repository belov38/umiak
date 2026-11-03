import { redirect } from "next/navigation";
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { PageHeader } from "@/components/ui/panel";
import { SandboxList } from "@/features/sandboxes/sandbox-list";
import { getDeploymentMeta } from "@/lib/deployment-meta";
import { getAppSession } from "@/lib/session";

/** /app → the default team (S8 §9.2). */
export default async function AppIndex() {
	const s = await getAppSession();
	if ((await getDeploymentMeta()).tenancy === "single") {
		return (
			<DefaultTeamShell>
				<SandboxList teamId={s.defaultTeamId} />
			</DefaultTeamShell>
		);
	}
	if (s.defaultTeamId !== "") redirect(`/app/t/${s.defaultTeamId}`);
	return (
		<main className="mx-auto max-w-xl p-8">
			<PageHeader title="No team" />
			<p className="mt-2 text-muted-foreground">
				You are not a member of any team. Ask a team owner to invite you.
			</p>
		</main>
	);
}

import { redirect } from "next/navigation";
// New shared team (S8 §9.9): name → server action → the new team.
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { NewTeamForm } from "@/components/app/new-team-form";
import { getDeploymentMeta } from "@/lib/deployment-meta";

export default async function NewTeamPage() {
	if ((await getDeploymentMeta()).tenancy === "single")
		redirect("/app/settings");

	return (
		<DefaultTeamShell>
			<NewTeamForm />
		</DefaultTeamShell>
	);
}

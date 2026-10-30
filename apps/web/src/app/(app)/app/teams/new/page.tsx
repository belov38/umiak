// New shared team (S8 §9.9): name → server action → the new team.
import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { NewTeamForm } from "@/components/app/new-team-form";

export default function NewTeamPage() {
	return (
		<DefaultTeamShell>
			<NewTeamForm />
		</DefaultTeamShell>
	);
}

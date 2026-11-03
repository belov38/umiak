import { DefaultTeamShell } from "@/components/app/default-team-shell";
import { TemplateList } from "@/features/templates/template-list";
import { getAppSession } from "@/lib/session";

export default async function TemplatesPage() {
	const session = await getAppSession();
	return (
		<DefaultTeamShell>
			<TemplateList
				teamId={session.defaultTeamId}
				quickstart={process.env.UMIAK_QUICKSTART === "1"}
			/>
		</DefaultTeamShell>
	);
}

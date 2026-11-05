import { redirect } from "next/navigation";
import { getAppSession } from "@/lib/session";
import { teamPath } from "@/lib/team-path";

export default async function DefaultTeamRedirect() {
	const session = await getAppSession();
	if (session.defaultTeamId === "") redirect("/app");
	redirect(teamPath(session.defaultTeamId, "environments"));
}

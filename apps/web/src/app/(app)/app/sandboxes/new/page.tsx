import { redirect } from "next/navigation";
import { getAppSession } from "@/lib/session";
import { teamPath } from "@/lib/team-path";

/** Setup does not know the owner's default team until the dashboard session loads. */
export default async function NewSandboxRedirect() {
	const session = await getAppSession();
	if (session.defaultTeamId === "") redirect("/app");
	redirect(teamPath(session.defaultTeamId, "sandboxes/new"));
}

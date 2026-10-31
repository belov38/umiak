import { redirect } from "next/navigation";
import { getAppSession } from "@/lib/session";

/** /app → the default team (S8 §9.2). */
export default async function AppIndex() {
	const s = await getAppSession();
	if (s.defaultTeamId !== "") redirect(`/app/t/${s.defaultTeamId}`);
	return (
		<main className="mx-auto max-w-xl p-8">
			<h1 className="text-xl font-semibold">No team</h1>
			<p className="mt-2 text-muted-foreground">
				You are not a member of any team. Ask a team owner to invite you.
			</p>
		</main>
	);
}

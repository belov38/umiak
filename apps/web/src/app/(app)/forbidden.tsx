// 403 of /app: a refused login (S8 §5.3 items 1, 2, 4) or a team the user is
// not in (S8 §9.2).
import { requestAuth } from "@/lib/session";

const TEXT: Record<string, { title: string; text: string }> = {
	user_disabled: {
		title: "Account disabled",
		text: "Your account is disabled. Ask a platform operator if this is a mistake.",
	},
	identity_conflict: {
		title: "Account conflict",
		text: "This email belongs to another account, or your identity provider account has changed. Ask a platform operator.",
	},
	team: {
		title: "No access to this team",
		text: "You are not a member of this team. Ask a team owner to invite you, or pick another team.",
	},
};

export default async function Forbidden() {
	const a = await requestAuth().catch(() => null);
	const t = (a?.kind === "denied" && TEXT[a.reason]) || TEXT.team;
	return (
		<main className="mx-auto max-w-xl p-8">
			<h1 className="text-xl font-semibold">{t?.title}</h1>
			<p className="mt-2 text-muted-foreground">{t?.text}</p>
			{a?.kind === "session" && (
				<p className="mt-4">
					<a className="underline" href="/app">
						Go to your default team
					</a>
				</p>
			)}
		</main>
	);
}

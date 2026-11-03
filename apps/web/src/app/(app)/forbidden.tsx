import { AccessPage } from "@/components/app/access-page";
import { PageHeader } from "@/components/ui/panel";
// 403 of /app: a refused login (S8 §5.3 items 1, 2, 4) or a team the user is
// not in (S8 §9.2).
import { getDeploymentMeta } from "@/lib/deployment-meta";
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
	const singleOwner = (await getDeploymentMeta()).tenancy === "single";
	const t = singleOwner
		? {
				title: "Access unavailable",
				text: "You do not have access to this resource.",
			}
		: (a?.kind === "denied" && TEXT[a.reason]) || TEXT.team;
	return (
		<AccessPage>
			<PageHeader title={t?.title} />
			<p className="mt-2 text-muted-foreground">{t?.text}</p>
			{a?.kind === "session" && (
				<p className="mt-4">
					<a className="underline" href="/app">
						{singleOwner ? "Go to sandboxes" : "Go to your default team"}
					</a>
				</p>
			)}
		</AccessPage>
	);
}

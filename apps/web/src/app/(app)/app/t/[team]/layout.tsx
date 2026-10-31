// The frame of a team's pages (S8 §9.3). The team is part of the path; a
// team the user is not in (and is no operator) gets the 403 page.
import { decodeUuid } from "@sbx/auth";
import { forbidden, notFound } from "next/navigation";
import type React from "react";
import { AppShell } from "@/components/app/app-shell";
import { webEnv } from "@/lib/env";
import { getWebPayload } from "@/lib/payload";
import { getAppSession } from "@/lib/session";

export default async function TeamLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ team: string }>;
}) {
	const { team } = await params;
	const session = await getAppSession();
	const uuid = decodeUuid("team", team);
	if (uuid === null) notFound();
	let current = session.teams.find((t) => t.id === team);
	if (current === undefined) {
		if (!session.isOperator) forbidden();
		// Operators may open any team (S8 §9.10).
		const payload = await getWebPayload();
		const doc = await payload.findByID({
			collection: "teams",
			id: uuid,
			depth: 0,
			disableErrors: true,
		});
		if (!doc) notFound();
		current = {
			id: team,
			name: String(doc.name),
			role: "member",
			personal: doc.personal === true,
		};
	}
	const env = webEnv();
	return (
		<AppShell
			team={current}
			member={session.teams.some((t) => t.id === team)}
			logoutUrl={env.logoutUrl}
		>
			{children}
		</AppShell>
	);
}

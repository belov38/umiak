"use client";
import { createContext, type ReactNode, useContext } from "react";
import type { AppSession } from "@/lib/app-session";

const SessionContext = createContext<AppSession | null>(null);

export function SessionProvider({
	session,
	children,
}: {
	session: AppSession;
	children: ReactNode;
}) {
	return (
		<SessionContext.Provider value={session}>
			{children}
		</SessionContext.Provider>
	);
}

/** The session of the /app shell (public ids only). */
export function useAppSession(): AppSession {
	const s = useContext(SessionContext);
	if (s === null) throw new Error("useAppSession outside SessionProvider");
	return s;
}

/**
 * The caller's place in a team for `can()` (S8 §6.2): role null for an
 * operator outside the team.
 */
export function useTeamPermission(teamId: string): {
	session: AppSession;
	team: { role: "owner" | "member" | null; personal: boolean };
} {
	const session = useAppSession();
	const t = session.teams.find((x) => x.id === teamId);
	return {
		session,
		team: { role: t?.role ?? null, personal: t?.personal ?? false },
	};
}

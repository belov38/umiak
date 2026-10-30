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

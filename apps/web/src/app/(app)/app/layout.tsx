// Every /app page needs a session: the 401/403 pages otherwise.
import type React from "react";
import { SessionProvider } from "@/components/app/session-context";
import { UmiakProvider } from "@/lib/api";
import { getAppSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getAppSession();
	return (
		<SessionProvider session={session}>
			<UmiakProvider>{children}</UmiakProvider>
		</SessionProvider>
	);
}

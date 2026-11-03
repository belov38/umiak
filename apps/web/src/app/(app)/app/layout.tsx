// Every /app page needs a session: the 401/403 pages otherwise.
import type React from "react";
import { SessionProvider } from "@/components/app/session-context";
import { UmiakProvider } from "@/lib/api";
import { getDeploymentMeta } from "@/lib/deployment-meta";
import { getAppSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const session = await getAppSession();
	const { tenancy } = await getDeploymentMeta();
	return (
		<SessionProvider session={session} tenancy={tenancy}>
			<UmiakProvider>{children}</UmiakProvider>
		</SessionProvider>
	);
}

import { Button } from "@/components/ui/button";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/funnel-display/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Navigate,
	Outlet,
	RouterProvider,
	useLocation,
} from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/app/app-shell";
import { SessionProvider } from "@/components/app/session-context";
import { LoadingState } from "@/components/ui/feedback";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateSandboxForm } from "@/features/create/create-form";
import { EnvironmentsPage } from "@/features/environments/environments-page";
import { GettingStarted } from "@/features/getting-started/getting-started";
import { KeysPage } from "@/features/keys/keys-page";
import { SandboxPage } from "@/features/sandbox/sandbox-page";
import { SandboxList } from "@/features/sandboxes/sandbox-list";
import { SettingsPage } from "@/features/settings/settings-page";
import { SnapshotList } from "@/features/snapshots/snapshot-list";
import { TemplateList } from "@/features/templates/template-list";
import { UmiakProvider } from "@/lib/api";
import { parsePrefill } from "@/lib/create-form";
import { type SettingsSession, settingsCall } from "@/lib/settings";
import { teamPath } from "@/lib/team-path";
import "./styles.css";

function Application() {
	const query = useQuery({
		queryKey: ["settings-session"],
		queryFn: () => settingsCall<SettingsSession>("session"),
	});
	const location = useLocation();
	const client = useQueryClient();
	const data = query.data;
	const memberTeams = data?.teams
		.filter((t) => t.role !== null)
		.map((t) => ({ ...t, role: t.role as "owner" | "member" }));
	const teamId =
		location.pathname.match(/^\/app\/t\/([^/]+)/)?.[1] ?? data?.defaultTeamId;
	useEffect(
		() => () => {
			if (teamId)
				client.removeQueries({ predicate: (q) => q.queryKey.includes(teamId) });
		},
		[teamId, client],
	);
	if (query.isPending) return <LoadingState />;
	if (query.error || !data || !memberTeams) {
		return (
			<main className="mx-auto max-w-xl space-y-4 p-8">
				<h1 className="text-xl font-semibold">Unable to open Umiak</h1>
				<p role="alert">
					{query.error?.message ?? "Owner session unavailable"}
				</p>
				<a href="/signin">Sign in</a>
				<Button type="button" onClick={() => void query.refetch()}>
					Retry
				</Button>
			</main>
		);
	}
	const team =
		memberTeams.find((t) => t.id === teamId) ??
		memberTeams.find((t) => t.id === data.defaultTeamId) ??
		memberTeams[0];
	if (!team) return <p>No workspace is available.</p>;
	const session = { ...data, teams: memberTeams };
	const pathname = location.pathname;
	let content: import("react").ReactNode;
	const match = pathname.match(/^\/app\/t\/([^/]+)(?:\/(.*))?$/);
	const suffix = match?.[2] ?? "";
	if (match) {
		if (!memberTeams.some((t) => t.id === match[1]))
			content = <p role="alert">Workspace not found.</p>;
		else if (suffix === "sandboxes/new")
			content = (
				<CreateSandboxForm
					teamId={team.id}
					prefill={parsePrefill(
						Object.fromEntries(new URLSearchParams(location.searchStr)),
					)}
				/>
			);
		else if (suffix.startsWith("sandboxes/"))
			content = (
				<SandboxPage
					teamId={team.id}
					sandboxRef={decodeURIComponent(suffix.slice(10))}
				/>
			);
		else if (suffix === "snapshots")
			content = <SnapshotList teamId={team.id} />;
		else if (suffix === "environments")
			content = (
				<EnvironmentsPage
					teamId={team.id}
					people={{ [data.user.id]: data.user.name }}
				/>
			);
		else if (suffix === "keys") content = <KeysPage teamId={team.id} />;
		else if (suffix === "settings") content = <SettingsPage />;
		else if (suffix === "") content = <SandboxList teamId={team.id} />;
		else content = <p>Page not found.</p>;
	} else if (pathname.startsWith("/app/settings"))
		content = <SettingsPage section={pathname.split("/")[3] ?? "workspaces"} />;
	else if (pathname === "/app/templates")
		content = <TemplateList teamId={team.id} quickstart />;
	else if (pathname === "/app/getting-started" || pathname === "/app/help")
		content = (
			<GettingStarted
				deployment={{
					mode: "owner",
					tenancy: "single",
					apiUrl: window.location.origin,
					appUrl: window.location.origin,
					previewDomain: "",
				}}
			/>
		);
	else if (pathname === "/app/account")
		content = <Navigate to="/app/settings/account" replace />;
	else if (pathname === "/app/teams/new")
		content = <Navigate to="/app/settings/workspaces" replace />;
	else {
		const section = pathname.slice(5);
		content = (
			<Navigate
				to={section ? teamPath(team.id, section) : teamPath(team.id)}
				replace
			/>
		);
	}
	return (
		<SessionProvider session={session} tenancy="single">
			<AppShell key={team.id} team={team} member ownerMode quickstart>
				{content}
			</AppShell>
		</SessionProvider>
	);
}
const root = createRootRoute({ component: () => <Outlet /> });
const app = createRoute({
	getParentRoute: () => root,
	path: "/app",
	component: Application,
});
const pages = createRoute({
	getParentRoute: () => root,
	path: "/app/$",
	component: Application,
});
const index = createRoute({
	getParentRoute: () => root,
	path: "/",
	component: () => <Navigate to="/app" replace />,
});
const router = createRouter({
	routeTree: root.addChildren([app, pages, index]),
	defaultNotFoundComponent: () => <p>Page not found.</p>,
});
const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
createRoot(element).render(
	<StrictMode>
		<UmiakProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
				<Toaster />
			</TooltipProvider>
		</UmiakProvider>
	</StrictMode>,
);

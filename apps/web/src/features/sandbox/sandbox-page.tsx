"use client";
// The sandbox page (S8 §9.6): header with live state and actions, tabs
// Overview | Terminal | Commands | Files | Ports | SSH | Env | Desktop (the
// last only for sandboxes with a desktop endpoint). The tab is in
// `?tab=`; only the open tab is mounted, so leaving it closes its streams
// and sockets.
import { UmiakError } from "@umiak/sdk";
import { useEffect } from "react";
import { QueryError } from "@/components/app/query-error";
import { useSingleOwner } from "@/components/app/session-context";
import { LoadingState } from "@/components/ui/feedback";
import Link from "@/components/ui/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppNavigation, useSearchParams } from "@/lib/navigation";

import { teamPath } from "@/lib/team-path";
import { type SandboxTab, sandboxHref } from "../sandboxes/links";
import { CommandsTab } from "./commands";
import { DesktopTab } from "./desktop";
import { EnvTab } from "./env";
import { FilesTab } from "./files";
import { SandboxHeader } from "./header";
import { OverviewTab } from "./overview";
import { PortsTab } from "./ports";
import { SshTab } from "./ssh";
import { TerminalTab } from "./terminal";
import { useLiveSandbox } from "./use-sandbox";

type Tab = "overview" | SandboxTab;
const TABS: { id: Tab; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "terminal", label: "Terminal" },
	{ id: "commands", label: "Commands" },
	{ id: "files", label: "Files" },
	{ id: "ports", label: "Ports" },
	{ id: "ssh", label: "SSH" },
	{ id: "env", label: "Env" },
	{ id: "desktop", label: "Desktop" },
];

function isNotFound(e: unknown): boolean {
	return e instanceof UmiakError && e.status === 404;
}

export function SandboxPage({
	teamId,
	sandboxRef,
}: {
	teamId: string;
	sandboxRef: string;
}) {
	const singleOwner = useSingleOwner();
	const router = useAppNavigation();
	const params = useSearchParams();
	const live = useLiveSandbox(teamId, sandboxRef);
	const s = live.data;
	const desktop = Boolean(s?.endpoints.desktop);
	const tabs = TABS.filter((t) => t.id !== "desktop" || desktop);
	const asked = params.get("tab") ?? "overview";
	const tab: Tab = tabs.some((t) => t.id === asked)
		? (asked as Tab)
		: "overview";

	const open = (t: Tab) => {
		const slug = s?.slug ?? sandboxRef;
		router.replace(
			sandboxHref(teamId, slug, t === "overview" ? undefined : t),
			{ scroll: false },
		);
	};

	// A link by id (`sb_…`, from a snapshot's source) shows the slug in the URL.
	useEffect(() => {
		if (s && sandboxRef !== s.slug && sandboxRef === s.id) {
			const t = params.get("tab");
			router.replace(
				sandboxHref(teamId, s.slug, (t ?? undefined) as SandboxTab | undefined),
				{
					scroll: false,
				},
			);
		}
	}, [s, sandboxRef, teamId, router, params]);

	if (live.error && !s) {
		return (
			<section className="space-y-3">
				<Link
					href={teamPath(teamId)}
					className="text-sm text-muted-foreground hover:underline"
				>
					← Sandboxes
				</Link>
				{isNotFound(live.error) ? (
					<p className="text-sm" data-testid="sandbox-not-found">
						No sandbox <code>{sandboxRef}</code>{" "}
						{singleOwner
							? "is unavailable: it may have been deleted."
							: "in this team: it may have been deleted."}
					</p>
				) : (
					<QueryError
						error={live.error}
						what="the sandbox"
						onRetry={() => live.refetch()}
					/>
				)}
			</section>
		);
	}
	if (!s || !live.handle) return <LoadingState />;
	const handle = live.handle;

	return (
		<section className="space-y-4">
			<SandboxHeader
				teamId={teamId}
				sandbox={s}
				desktop={desktop}
				track={live.track}
			/>

			{live.error !== null && (
				<QueryError
					error={live.error}
					what="the latest state"
					onRetry={() => live.refetch()}
				/>
			)}
			{s.state === "deleted" ? (
				<p className="text-sm text-muted-foreground">
					This sandbox is deleted.
				</p>
			) : (
				<Tabs value={tab} onValueChange={(v) => open(v as Tab)}>
					<TabsList variant="line" className="flex-nowrap">
						{tabs.map((t) => (
							<TabsTrigger key={t.id} value={t.id} data-testid={`tab-${t.id}`}>
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>
					<TabsContent value="overview" className="min-w-0">
						<OverviewTab
							teamId={teamId}
							sandbox={s}
							handle={handle}
							onOpenTab={open}
						/>
					</TabsContent>
					<TabsContent value="terminal" className="sandbox-workspace">
						<TerminalTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="commands" className="sandbox-workspace">
						<CommandsTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="files" className="sandbox-workspace">
						<FilesTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="ports" className="sandbox-workspace">
						<PortsTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="ssh" className="sandbox-workspace">
						<SshTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="env" className="sandbox-workspace">
						<EnvTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					{desktop && (
						<TabsContent value="desktop" className="sandbox-workspace">
							<DesktopTab sandbox={s} handle={handle} track={live.track} />
						</TabsContent>
					)}
				</Tabs>
			)}
		</section>
	);
}

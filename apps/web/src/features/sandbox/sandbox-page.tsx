"use client";
// The sandbox page (S8 §9.6): header with live state and actions, tabs
// Overview | Terminal | Commands | Files | Ports | SSH | Env | Desktop (the
// last only for templates with the `desktop` capability). The tab is in
// `?tab=`; only the open tab is mounted, so leaving it closes its streams
// and sockets.
import { SbxError } from "@sbx/sdk";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { QueryError } from "@/components/app/query-error";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSbx } from "@/lib/api";
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
	return e instanceof SbxError && e.status === 404;
}

export function SandboxPage({
	teamId,
	sandboxRef,
}: {
	teamId: string;
	sandboxRef: string;
}) {
	const sbx = useSbx(teamId);
	const router = useRouter();
	const params = useSearchParams();
	const live = useLiveSandbox(teamId, sandboxRef);
	const s = live.data;
	const templates = useQuery({
		queryKey: ["templates", teamId],
		queryFn: ({ signal }) => sbx.templates({ signal }),
		staleTime: 5 * 60_000,
	});
	const desktop =
		s !== undefined &&
		(templates.data ?? []).some(
			(t) => t.slug === s.template && t.capabilities.includes("desktop"),
		);
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
						No sandbox <code>{sandboxRef}</code> in this team: it may have been
						deleted.
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
	if (!s || !live.handle)
		return <p className="text-sm text-muted-foreground">Loading…</p>;
	const handle = live.handle;

	return (
		<section className="space-y-4">
			<SandboxHeader teamId={teamId} sandbox={s} track={live.track} />
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
					<TabsList variant="line" className="flex-wrap">
						{tabs.map((t) => (
							<TabsTrigger key={t.id} value={t.id} data-testid={`tab-${t.id}`}>
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>
					<TabsContent value="overview" className="pt-3">
						<OverviewTab
							teamId={teamId}
							sandbox={s}
							handle={handle}
							onOpenTab={open}
						/>
					</TabsContent>
					<TabsContent value="terminal" className="pt-3">
						<TerminalTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="commands" className="pt-3">
						<CommandsTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="files" className="pt-3">
						<FilesTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="ports" className="pt-3">
						<PortsTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="ssh" className="pt-3">
						<SshTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					<TabsContent value="env" className="pt-3">
						<EnvTab teamId={teamId} sandbox={s} handle={handle} />
					</TabsContent>
					{desktop && (
						<TabsContent value="desktop" className="pt-3">
							<DesktopTab />
						</TabsContent>
					)}
				</Tabs>
			)}
		</section>
	);
}

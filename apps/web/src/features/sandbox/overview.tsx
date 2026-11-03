"use client";
import { useQuery } from "@tanstack/react-query";
// Overview tab (S8 §9.6): properties, endpoints (port URL template, SSH
// command), the last 10 commands and the published ports.
import type { Sandbox, SandboxData } from "@umiak/sdk";
import { CopyLine } from "@/components/app/copy-button";
import { QueryError } from "@/components/app/query-error";
import { Button } from "@/components/ui/button";
import { formatAgo, formatTime } from "@/lib/format";
import { formatDuration } from "./output";
import { portsKey } from "./ports";

export function OverviewTab({
	teamId,
	sandbox: s,
	handle,
	onOpenTab,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
	onOpenTab: (tab: "commands" | "ports") => void;
}) {
	const commands = useQuery({
		queryKey: ["commands", teamId, s.id, "last10"],
		queryFn: async ({ signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/commands",
				{
					params: { path: { sandbox: s.id }, query: { limit: 10 } },
					signal,
				},
			);
			return data.data;
		},
		refetchInterval: 10_000,
		refetchIntervalInBackground: false,
	});
	const ports = useQuery({
		queryKey: portsKey(teamId, s.id),
		queryFn: ({ signal }) => handle.ports.list({ signal }),
		refetchInterval: 10_000,
		refetchIntervalInBackground: false,
	});
	const now = Date.now();
	return (
		<div className="sandbox-overview">
			<section className="space-y-2">
				<h2 className="font-medium">Properties</h2>
				<dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-y-1 text-sm">
					<dt className="text-muted-foreground">ID</dt>
					<dd className="font-mono text-xs">{s.id}</dd>
					<dt className="text-muted-foreground">Created</dt>
					<dd>{formatTime(s.createdAt)}</dd>
					<dt className="text-muted-foreground">Ready since</dt>
					<dd>{formatTime(s.readyAt)}</dd>
					<dt className="text-muted-foreground">Stopped</dt>
					<dd>
						{formatTime(s.stoppedAt)}
						{s.stopReason && (
							<span className="text-muted-foreground"> ({s.stopReason})</span>
						)}
					</dd>
					<dt className="text-muted-foreground">Last activity</dt>
					<dd>{formatAgo(s.lastActivityAt, now)}</dd>
					{s.health === "degraded" && (
						<>
							<dt className="text-muted-foreground">Degraded since</dt>
							<dd>{formatTime(s.degradedSince)}</dd>
						</>
					)}
				</dl>
				<h2 className="pt-2 font-medium">Endpoints</h2>
				<p className="text-xs text-muted-foreground">
					Published port URLs (replace {"{port}"}):
				</p>
				<CopyLine
					text={s.endpoints.portUrlTemplate}
					label="Copy the port URL template"
				/>
				<p className="text-xs text-muted-foreground">SSH:</p>
				<CopyLine text={s.endpoints.ssh} label="Copy the SSH command" />
			</section>
			<section className="space-y-4">
				<div className="space-y-1">
					<div className="flex items-center">
						<h2 className="font-medium">Last commands</h2>
						<Button
							variant="link"
							size="inline"
							type="button"
							className="ml-auto "
							onClick={() => onOpenTab("commands")}
						>
							All commands
						</Button>
					</div>
					{commands.isError && (
						<QueryError error={commands.error} what="commands" />
					)}
					{commands.data?.length === 0 && (
						<p className="text-sm text-muted-foreground">None yet.</p>
					)}
					<ul
						className="divide-y border text-sm"
						data-testid="overview-commands"
					>
						{(commands.data ?? []).map((c) => (
							<li key={c.id} className="flex items-center gap-2 p-1.5">
								<span className="w-20 text-xs text-muted-foreground">
									{c.status}
								</span>
								<code className="flex-1 truncate text-xs">
									{c.mode === "pty" ? "[pty] " : ""}
									{c.command ?? c.argv?.join(" ") ?? "login shell"}
								</code>
								<span className="text-xs text-muted-foreground">
									{c.exitCode ?? ""}
								</span>
								<span className="w-20 text-right text-xs text-muted-foreground">
									{formatDuration(c.startedAt, c.endedAt, now)}
								</span>
							</li>
						))}
					</ul>
				</div>
				<div className="space-y-1">
					<div className="flex items-center">
						<h2 className="font-medium">Published ports</h2>
						<Button
							variant="link"
							size="inline"
							type="button"
							className="ml-auto "
							onClick={() => onOpenTab("ports")}
						>
							Manage
						</Button>
					</div>
					{ports.isError && <QueryError error={ports.error} what="ports" />}
					{ports.data?.hosted.length === 0 && (
						<p className="text-sm text-muted-foreground">None.</p>
					)}
					<ul className="divide-y border text-sm">
						{(ports.data?.hosted ?? []).map((p) => (
							<li key={p.port} className="flex items-center gap-2 p-1.5">
								<span className="w-14 font-mono">{p.port}</span>
								<a
									href={p.url}
									target="_blank"
									rel="noopener noreferrer"
									className="flex-1 truncate font-mono text-xs underline"
								>
									{p.url}
								</a>
								<span className="text-xs text-muted-foreground">
									{p.access}
								</span>
								{p.blocked && (
									<span className="text-xs text-warning">blocked</span>
								)}
							</li>
						))}
					</ul>
				</div>
			</section>
		</div>
	);
}

"use client";
// /app/t/<team>/environments (S8 §10): the team's environments from
// GET /v1/environments — env and secret names (secret values never),
// secret file metadata, repositories, default, revision, last change.
// Create, edit and delete for owners and operators (§6.2); members read.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayersIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { EmptyState as DashboardEmpty } from "@/components/app/empty-state";
import { QueryError } from "@/components/app/query-error";
import { useTeamPermission } from "@/components/app/session-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/features/sandbox/rules";
import { useUmiak } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import type { EnvironmentSummary } from "@/lib/environment-form";
import { formatAgo, formatTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { EnvironmentDialog } from "./environment-dialog";

export function EnvironmentsPage({
	teamId,
	people,
}: {
	teamId: string;
	/** `usr_...` → name of the team's members. */
	people: Record<string, string>;
}) {
	const umiak = useUmiak(teamId);
	const queryClient = useQueryClient();
	const { session, team } = useTeamPermission(teamId);
	const canManage = can(session, team, "manageEnvironments");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ editing: string | null } | null>(null);

	const list = useQuery({
		queryKey: ["environments", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await umiak.raw.GET("/v1/environments", { signal });
			return data.data;
		},
	});

	const remove = async (e: EnvironmentSummary): Promise<boolean> => {
		const r = await attempt(() =>
			umiak.raw.DELETE("/v1/environments/{environment}", {
				params: { path: { environment: e.id } },
			}),
		);
		await queryClient.invalidateQueries({ queryKey: ["environments", teamId] });
		if (r === undefined) return false;
		toast.success(`Environment ${e.name} deleted`);
		return true;
	};

	const updatedBy = (e: EnvironmentSummary): string => {
		if (e.updatedBy === null) return "a team key";
		if (e.updatedBy === session.user.id) return "you";
		return people[e.updatedBy] ?? "a former member";
	};

	const now = Date.now();
	const selected =
		list.data?.find((e) => e.id === selectedId) ??
		list.data?.find((e) => e.isDefault) ??
		list.data?.[0];
	return (
		<section className="environments-page space-y-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<h1 className="text-xl font-semibold">Environment</h1>
			</div>
			<p className="text-sm text-muted-foreground">
				Named env, secrets, secret files and repositories that new sandboxes get
				at create. Changes apply to new sandboxes only.
			</p>
			<div className="environment-toolbar">
				{selected && (
					<Select value={selected.id} onValueChange={setSelectedId}>
						<SelectTrigger
							aria-label="Environment"
							className="min-w-48 max-w-full"
						>
							<LayersIcon />
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{list.data?.map((e) => (
								<SelectItem key={e.id} value={e.id}>
									{e.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				{canManage && (
					<Button
						variant="ghost"
						size="icon"
						aria-label="New environment"
						title="New environment"
						onClick={() => setDialog({ editing: null })}
					>
						<PlusIcon />
					</Button>
				)}
			</div>
			{!canManage && (
				<p className="text-sm text-muted-foreground">
					Only owners of the team create, change and delete environments.
				</p>
			)}
			{list.isError && (
				<QueryError
					error={list.error}
					what="environments"
					onRetry={() => list.refetch()}
				/>
			)}
			{list.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{list.data && list.data.length === 0 && (
				<DashboardEmpty kind="environments">
					No environments yet.
					{canManage
						? " Create one to give new sandboxes shared env, secrets and repositories."
						: ""}
				</DashboardEmpty>
			)}
			<div className="grid gap-3" data-testid="environment-list">
				{(list.data ?? []).map((e) => (
					<article
						key={e.id}
						className="environment-summary space-y-3"
						data-testid="environment"
						data-selected={e.id === selected?.id}
					>
						<header className="flex flex-wrap items-center gap-2">
							<h2>
								<button
									type="button"
									className="environment-name"
									aria-expanded={e.id === selected?.id}
									onClick={() => setSelectedId(e.id)}
								>
									{e.name}
								</button>
							</h2>
							{e.isDefault && <Badge>default</Badge>}
							{e.excludeOwnerSecrets && (
								<Badge variant="outline">no personal secrets</Badge>
							)}
							<span
								className="text-xs text-muted-foreground"
								title={formatTime(e.updatedAt)}
							>
								revision {e.revision} · updated {formatAgo(e.updatedAt, now)} by{" "}
								{updatedBy(e)}
							</span>
							{canManage && (
								<div className="ml-auto flex gap-1">
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label={`Edit environment ${e.name}`}
										title={`Edit environment ${e.name}`}
										onClick={() => setDialog({ editing: e.id })}
									>
										<PencilIcon />
									</Button>
									<ConfirmButton
										title={`Delete environment ${e.name}?`}
										description="Sandboxes created from it keep their values. New creates no longer get it."
										confirmLabel="Delete"
										size="icon-sm"
										variant="ghost"
										ariaLabel={`Delete environment ${e.name}`}
										onConfirm={() => remove(e)}
									>
										<TrashIcon />
									</ConfirmButton>
								</div>
							)}
						</header>
						{e.id === selected?.id && (
							<dl className="grid gap-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
								<Row label="Env">
									<Names names={e.envKeys} />
								</Row>
								<Row label="Secrets">
									<Names names={e.secretKeys} secret />
								</Row>
								<Row label="Secret files">
									{e.secretFiles.length === 0 ? (
										<None />
									) : (
										<ul className="space-y-0.5">
											{e.secretFiles.map((f) => (
												<li key={f.name}>
													<span className="font-mono">{f.name}</span>{" "}
													<span className="text-xs text-muted-foreground">
														{f.mode.toString(8).padStart(4, "0")} ·{" "}
														{formatBytes(f.sizeBytes)}
														{f.linkPath ? ` · → ${f.linkPath}` : ""}
													</span>
												</li>
											))}
										</ul>
									)}
								</Row>
								<Row label="Repositories">
									{e.repositories.length === 0 ? (
										<None />
									) : (
										<ul className="space-y-0.5">
											{e.repositories.map((r, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: the same URL may appear twice
												<li key={i} className="font-mono text-xs">
													{r.url}
													{r.branch && (
														<span className="text-muted-foreground">
															{" "}
															@ {r.branch}
														</span>
													)}
													{r.path && (
														<span className="text-muted-foreground">
															{" "}
															→ ~/{r.path}
														</span>
													)}
												</li>
											))}
										</ul>
									)}
								</Row>
							</dl>
						)}
					</article>
				))}
			</div>
			<EnvironmentDialog
				teamId={teamId}
				editing={dialog?.editing ?? null}
				open={dialog !== null}
				onOpenChange={(o) => !o && setDialog(null)}
				onCreated={setSelectedId}
			/>
		</section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</>
	);
}

function None() {
	return <span className="text-muted-foreground">—</span>;
}

function Names({ names, secret }: { names: string[]; secret?: boolean }) {
	if (names.length === 0) return <None />;
	return (
		<div className="flex flex-wrap gap-1">
			{names.map((n) => (
				<Badge key={n} variant="secondary" className="font-mono">
					{n}
					{secret ? " •••" : ""}
				</Badge>
			))}
		</div>
	);
}

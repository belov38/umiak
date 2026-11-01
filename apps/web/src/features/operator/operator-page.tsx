"use client";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
// /app/operator (S8 §9.10): sandboxes of every team, GET /v1/sandboxes
// ?allTeams=true with team, state and search filters; the team column and
// filter come from Payload (passed in by the server page). Actions per row
// in OperatorActions, the ports of a row on expand. Pool and node status
// are phase 2 (`umiak-admin pool status`).
import type { SandboxData } from "@umiak/sdk";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { QueryError } from "@/components/app/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { sandboxHref } from "@/features/sandboxes/links";
import {
	BlockLock,
	HealthCell,
	StateCell,
} from "@/features/sandboxes/state-cell";
import { useUmiak } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import {
	type OperatorFilter,
	type OperatorTeam,
	operatorListQuery,
	teamNameOf,
} from "@/lib/operator";
import {
	POLL_MS,
	POLL_RETRY_BUDGET_MS,
	type SandboxState,
	STATE_FILTERS,
} from "@/lib/sandboxes";
import { teamPath } from "@/lib/team-path";
import { OPERATOR_SANDBOXES_KEY, OperatorActions } from "./operator-actions";
import { PortBlocks } from "./port-blocks";

export function OperatorPage({ teams }: { teams: OperatorTeam[] }) {
	// Not about one team: the operator's default team, allTeams does the rest.
	const umiak = useUmiak("");
	const names = useMemo(
		() => new Map(teams.map((t) => [t.id, t.name])),
		[teams],
	);
	const [q, setQ] = useState("");
	const [debouncedQ, setDebouncedQ] = useState("");
	const [state, setState] = useState<SandboxState | "all">("all");
	const [teamId, setTeamId] = useState("all");
	const [openPorts, setOpenPorts] = useState<string | null>(null);

	useEffect(() => {
		const t = setTimeout(() => setDebouncedQ(q), 300);
		return () => clearTimeout(t);
	}, [q]);

	const filter: OperatorFilter = useMemo(
		() => ({ teamId, state, q: debouncedQ }),
		[teamId, state, debouncedQ],
	);

	const list = useInfiniteQuery({
		queryKey: [OPERATOR_SANDBOXES_KEY, filter],
		queryFn: async ({ pageParam, signal }) => {
			const { data } = await umiak.raw.GET("/v1/sandboxes", {
				params: { query: operatorListQuery(filter, pageParam) },
				signal,
				retryBudgetMs: POLL_RETRY_BUDGET_MS,
			});
			return data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		placeholderData: keepPreviousData,
		refetchInterval: POLL_MS,
		refetchIntervalInBackground: false,
	});
	const rows = useMemo(
		() =>
			(list.data?.pages ?? [])
				.flatMap((p) => p.data)
				.filter((s) => s.state !== "deleted"),
		[list.data],
	);

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<h1 className="text-xl font-semibold">Operator</h1>
				<p className="text-sm text-muted-foreground">
					Sandboxes of every team. Templates, sizes, quotas, teams and users are
					configured in the admin.
				</p>
				<Button asChild variant="outline" className="ml-auto">
					{/* The admin is another root layout: a full page load. */}
					<a href="/admin">Open admin</a>
				</Button>
			</div>
			<div className="flex flex-wrap items-start gap-2">
				<Input
					aria-label="Search name or slug"
					placeholder="Search name/slug"
					className="w-56"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<Select value={teamId} onValueChange={setTeamId}>
					<SelectTrigger aria-label="Team" className="w-56">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">team: all</SelectItem>
						{teams.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name}
								{t.personal ? " (personal)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={state}
					onValueChange={(v) => setState(v as SandboxState | "all")}
				>
					<SelectTrigger aria-label="State" className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">state: all</SelectItem>
						{STATE_FILTERS.map((s) => (
							<SelectItem key={s} value={s}>
								{s}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{list.isError && (
				<QueryError
					error={list.error}
					what="sandboxes"
					onRetry={() => list.refetch()}
				/>
			)}
			{list.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{list.data && rows.length === 0 && (
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No sandbox matches the filters.
				</div>
			)}
			{rows.length > 0 && (
				<OperatorTable
					rows={rows}
					names={names}
					openPorts={openPorts}
					onTogglePorts={(id) =>
						setOpenPorts((cur) => (cur === id ? null : id))
					}
				/>
			)}
			{list.hasNextPage && (
				<div className="flex justify-center py-2">
					<Button
						variant="outline"
						size="sm"
						disabled={list.isFetchingNextPage}
						onClick={() => list.fetchNextPage()}
					>
						{list.isFetchingNextPage ? "Loading…" : "Load more"}
					</Button>
				</div>
			)}
		</section>
	);
}

function OperatorTable({
	rows,
	names,
	openPorts,
	onTogglePorts,
}: {
	rows: SandboxData[];
	names: Map<string, string>;
	openPorts: string | null;
	onTogglePorts: (id: string) => void;
}) {
	const now = Date.now();
	return (
		<Table data-testid="operator-table">
			<TableHeader>
				<TableRow>
					<TableHead>Team</TableHead>
					<TableHead>Name / slug</TableHead>
					<TableHead>Template / size</TableHead>
					<TableHead>State</TableHead>
					<TableHead>Health</TableHead>
					<TableHead>Created</TableHead>
					<TableHead />
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((s) => (
					<Fragment key={s.id}>
						<TableRow data-testid="operator-row">
							<TableCell>
								<Link
									href={teamPath(s.teamId)}
									className="hover:underline"
									title={s.teamId}
								>
									{teamNameOf(names, s.teamId)}
								</Link>
							</TableCell>
							<TableCell>
								<Link
									href={sandboxHref(s.teamId, s.slug)}
									className="flex items-center gap-1 font-medium hover:underline"
								>
									{s.name ?? s.slug}
									<BlockLock sandbox={s} />
								</Link>
								{s.name !== null && (
									<div className="text-xs text-muted-foreground">{s.slug}</div>
								)}
								{s.blocked && (
									<div className="text-xs text-amber-700">
										blocked{s.blockReason ? ` (${s.blockReason})` : ""}
									</div>
								)}
							</TableCell>
							<TableCell>
								{s.template}
								<div className="text-xs text-muted-foreground">
									{s.size} · {s.memoryMb} MB
								</div>
							</TableCell>
							<TableCell>
								<StateCell sandbox={s} />
							</TableCell>
							<TableCell>
								<HealthCell sandbox={s} />
							</TableCell>
							<TableCell>{formatAgo(s.createdAt, now)}</TableCell>
							<TableCell>
								<OperatorActions
									sandbox={s}
									portsOpen={openPorts === s.id}
									onTogglePorts={() => onTogglePorts(s.id)}
								/>
							</TableCell>
						</TableRow>
						{openPorts === s.id && (
							<TableRow>
								<TableCell colSpan={7} className="bg-muted/40">
									<PortBlocks sandbox={s} />
								</TableCell>
							</TableRow>
						)}
					</Fragment>
				))}
			</TableBody>
		</Table>
	);
}

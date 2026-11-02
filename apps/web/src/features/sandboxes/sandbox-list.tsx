"use client";
import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
// /app/t/<team> (S8 §9.4): the team's sandboxes. GET /v1/sandboxes with
// filters and infinite scroll over `nextCursor`; quota and usage from
// GET /v1/limits. Refreshed every 5 s while the tab is visible and at once
// after an action.
import type { SandboxData } from "@umiak/sdk";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/app/copy-button";
import { EmptyState as DashboardEmpty } from "@/components/app/empty-state";
import { QueryError } from "@/components/app/query-error";
import { useAppSession } from "@/components/app/session-context";
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
import { useUmiak } from "@/lib/api";
import type { ApiKey } from "@/lib/api-keys";
import { formatAgo, formatTime } from "@/lib/format";
import {
	type ListFilter,
	listQuery,
	POLL_MS,
	POLL_RETRY_BUDGET_MS,
	parseLabelFilter,
	type SandboxState,
	STATE_FILTERS,
} from "@/lib/sandboxes";
import { teamPath } from "@/lib/team-path";
import { sandboxHref } from "./links";
import { RowActions } from "./row-actions";
import { BlockLock, HealthCell, StateCell } from "./state-cell";

export function SandboxList({ teamId }: { teamId: string }) {
	const umiak = useUmiak(teamId);
	const [q, setQ] = useState("");
	const [debouncedQ, setDebouncedQ] = useState("");
	const [state, setState] = useState<SandboxState | "all">("all");
	const [labelText, setLabelText] = useState("");
	const [labels, setLabels] = useState<Record<string, string>>({});
	const [labelError, setLabelError] = useState<string | null>(null);

	useEffect(() => {
		const t = setTimeout(() => setDebouncedQ(q), 300);
		return () => clearTimeout(t);
	}, [q]);

	const filter: ListFilter = useMemo(
		() => ({ q: debouncedQ, state, labels }),
		[debouncedQ, state, labels],
	);

	const list = useInfiniteQuery({
		queryKey: ["sandboxes", teamId, filter],
		queryFn: async ({ pageParam, signal }) => {
			const { data } = await umiak.raw.GET("/v1/sandboxes", {
				params: { query: listQuery(filter, pageParam) },
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

	const applyLabels = () => {
		const r = parseLabelFilter(labelText);
		if (r.ok) {
			setLabelError(null);
			setLabels(r.labels);
		} else setLabelError(r.error);
	};

	const rows = useMemo(
		() =>
			(list.data?.pages ?? [])
				.flatMap((p) => p.data)
				.filter((s) => s.state !== "deleted"),
		[list.data],
	);
	const filtered =
		debouncedQ.trim() !== "" ||
		state !== "all" ||
		Object.keys(labels).length > 0;

	return (
		<section className="sandbox-list space-y-4">
			<div className="sandbox-list-header flex flex-wrap items-center gap-x-4 gap-y-2">
				<h1 className="text-xl font-semibold">Sandboxes</h1>
				<QuotaLine teamId={teamId} />
				<Button asChild className="ml-auto">
					<Link href={teamPath(teamId, "sandboxes/new")}>
						<PlusIcon />
						New sandbox
					</Link>
				</Button>
			</div>
			<div className="sandbox-filters flex flex-wrap items-start gap-2">
				<Input
					aria-label="Search name or slug"
					placeholder="Search name or slug"
					className="w-80 max-w-full"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<Select
					value={state}
					onValueChange={(v) => setState(v as SandboxState | "all")}
				>
					<SelectTrigger aria-label="State">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">State</SelectItem>
						{STATE_FILTERS.map((s) => (
							<SelectItem key={s} value={s}>
								{s}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="space-y-1">
					<Input
						aria-label="Label filter"
						placeholder="label: k=v (Enter)"
						className="w-56"
						aria-invalid={labelError !== null}
						value={labelText}
						onChange={(e) => setLabelText(e.target.value)}
						onBlur={applyLabels}
						onKeyDown={(e) => {
							if (e.key === "Enter") applyLabels();
						}}
					/>
					{labelError && (
						<p className="text-xs text-destructive">{labelError}</p>
					)}
				</div>
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
				<EmptyState teamId={teamId} filtered={filtered} />
			)}
			{rows.length > 0 && <SandboxTable teamId={teamId} rows={rows} />}
			{list.hasNextPage && (
				<LoadMore
					loading={list.isFetchingNextPage}
					onLoad={() => {
						if (!list.isFetchingNextPage) list.fetchNextPage();
					}}
				/>
			)}
		</section>
	);
}

function QuotaLine({ teamId }: { teamId: string }) {
	const umiak = useUmiak(teamId);
	const limits = useQuery({
		queryKey: ["limits", teamId],
		queryFn: ({ signal }) =>
			umiak.limits({ signal, retryBudgetMs: POLL_RETRY_BUDGET_MS }),
		refetchInterval: POLL_MS,
		refetchIntervalInBackground: false,
	});
	if (!limits.data) return null;
	const { usage, quota, canCreate } = limits.data;
	return (
		<p className="text-sm text-muted-foreground" data-testid="quota-line">
			{usage.activeSandboxes} of {quota.maxActiveSandboxes} active ·{" "}
			{usage.ramMb} of {quota.maxRamMb} MB
			{!canCreate && <span className="ml-2 text-warning">quota reached</span>}
		</p>
	);
}

function EmptyState({
	teamId,
	filtered,
}: {
	teamId: string;
	filtered: boolean;
}) {
	return (
		<DashboardEmpty kind="sandboxes">
			{filtered ? (
				"No sandbox matches the filters."
			) : (
				<>
					No sandboxes yet.{" "}
					<Link
						href={teamPath(teamId, "sandboxes/new")}
						className="text-foreground underline"
					>
						Create one
					</Link>{" "}
					here, or with <code>umiak create</code>.
				</>
			)}
		</DashboardEmpty>
	);
}

/** Who created the sandbox, as far as the browser knows. */
function useCreatorName(teamId: string): (s: SandboxData) => string {
	const session = useAppSession();
	const umiak = useUmiak(teamId);
	const keys = useQuery({
		queryKey: ["api-keys", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await umiak.raw.GET("/v1/api-keys", { signal });
			return data.data;
		},
		staleTime: 60_000,
	});
	const names = useMemo(
		() => new Map((keys.data ?? []).map((k: ApiKey) => [k.id, k.name])),
		[keys.data],
	);
	return (s) => {
		if (s.createdBy !== null && s.createdBy === session.user.id) return "you";
		if (s.createdByKey !== null) {
			const n = names.get(s.createdByKey);
			return n === undefined ? "a team key" : `key ${n}`;
		}
		return s.createdBy === null ? "—" : "a teammate";
	};
}

function SandboxTable({
	teamId,
	rows,
}: {
	teamId: string;
	rows: SandboxData[];
}) {
	const creator = useCreatorName(teamId);
	const now = Date.now();
	return (
		<>
			<div className="sandbox-desktop-table">
				<Table data-testid="sandbox-table">
					<TableHeader>
						<TableRow>
							<TableHead>Name / slug</TableHead>
							<TableHead>Sandbox ID</TableHead>
							<TableHead>State</TableHead>
							<TableHead>Created</TableHead>
							<TableHead>Type</TableHead>
							<TableHead>Health</TableHead>
							<TableHead>Activity</TableHead>
							<TableHead>Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((s) => (
							<TableRow key={s.id} data-testid="sandbox-row">
								<TableCell>
									<Link
										href={sandboxHref(teamId, s.slug)}
										className="sandbox-row-name"
									>
										{s.name ?? s.slug}
										<BlockLock sandbox={s} />
									</Link>
									<div className="mt-2 truncate font-mono text-xs text-muted-foreground">
										{s.slug}
									</div>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-1">
										<code
											title={s.id}
											className="max-w-28 truncate text-xs text-muted-foreground"
										>
											{s.id}
										</code>
										<CopyButton text={s.id} label="Copy sandbox ID" />
									</div>
								</TableCell>
								<TableCell>
									<StateCell sandbox={s} />
								</TableCell>
								<TableCell className="text-xs whitespace-nowrap">
									{formatTime(s.createdAt)}
									<div
										className="mt-1 text-muted-foreground"
										data-testid="sandbox-creator"
									>
										by {creator(s)}
									</div>
								</TableCell>
								<TableCell className="text-xs">
									<span title={`${s.vcpu} vCPU / ${s.memoryMb} MB`}>
										{s.size}
									</span>
									<div className="mt-1 text-muted-foreground">{s.template}</div>
								</TableCell>
								<TableCell className="text-xs">
									<HealthCell sandbox={s} />
								</TableCell>
								<TableCell className="text-xs text-muted-foreground">
									{s.activity}
								</TableCell>
								<TableCell>
									<RowActions teamId={teamId} sandbox={s} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div className="sandbox-cards">
				{rows.map((s) => (
					<article
						key={s.id}
						className="sandbox-card"
						data-testid="sandbox-card"
					>
						<header className="flex flex-col items-start gap-1 pr-16">
							<Link
								href={sandboxHref(teamId, s.slug)}
								className="sandbox-row-name"
							>
								{s.name ?? s.slug}
							</Link>
							<StateCell sandbox={s} />
							<BlockLock sandbox={s} />
							<RowActions teamId={teamId} sandbox={s} />
						</header>
						<div className="font-mono text-xs text-muted-foreground">
							{s.slug}
						</div>
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<code>{s.id}</code>
							<CopyButton text={s.id} label="Copy sandbox ID" />
						</div>
						<p className="text-xs text-muted-foreground">
							{s.template} · {s.size} · {s.vcpu} vCPU / {s.memoryMb} MB
						</p>
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<HealthCell sandbox={s} />
							<span className="text-muted-foreground">
								Activity: {s.activity}
							</span>
						</div>
						{s.health === "degraded" && s.healthReason && (
							<p className="text-xs text-warning">{s.healthReason}</p>
						)}
						<footer className="flex items-center justify-between gap-2 text-xs">
							<span>
								created {formatAgo(s.createdAt, now)} by {creator(s)}
							</span>
						</footer>
					</article>
				))}
			</div>
		</>
	);
}

/** Loads the next page when it scrolls into view; a button as fallback. */
function LoadMore({
	loading,
	onLoad,
}: {
	loading: boolean;
	onLoad: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const load = useRef(onLoad);
	load.current = onLoad;
	useEffect(() => {
		const el = ref.current;
		if (el === null || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) load.current();
		});
		io.observe(el);
		return () => io.disconnect();
	}, []);
	return (
		<div ref={ref} className="flex justify-center py-2">
			<Button variant="outline" size="sm" disabled={loading} onClick={onLoad}>
				{loading ? "Loading…" : "Load more"}
			</Button>
		</div>
	);
}

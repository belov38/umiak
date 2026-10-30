"use client";
// Header of the sandbox page (S8 §9.6) until the full page with tabs
// (plan task 12): name, slug, state, active operation, the row actions.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { QueryError } from "@/components/app/query-error";
import { useSbx } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { POLL_MS, POLL_RETRY_BUDGET_MS } from "@/lib/sandboxes";
import { teamPath } from "@/lib/team-path";
import { RowActions } from "./row-actions";
import { BlockLock, HealthCell, StateCell } from "./state-cell";

export function SandboxSummary({
	teamId,
	slug,
}: {
	teamId: string;
	slug: string;
}) {
	const sbx = useSbx(teamId);
	const q = useQuery({
		queryKey: ["sandboxes", teamId, "one", slug],
		queryFn: async ({ signal }) => {
			const { data } = await sbx.raw.GET("/v1/sandboxes/{sandbox}", {
				params: { path: { sandbox: slug } },
				signal,
				retryBudgetMs: POLL_RETRY_BUDGET_MS,
			});
			return data;
		},
		refetchInterval: POLL_MS,
		refetchIntervalInBackground: false,
	});
	const s = q.data;
	return (
		<section className="space-y-4">
			<Link
				href={teamPath(teamId)}
				className="text-sm text-muted-foreground hover:underline"
			>
				← Sandboxes
			</Link>
			{q.isError && (
				<QueryError
					error={q.error}
					what="the sandbox"
					onRetry={() => q.refetch()}
				/>
			)}
			{q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
			{s && (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="flex items-center gap-2 text-xl font-semibold">
							{s.name ?? s.slug}
							<BlockLock sandbox={s} />
						</h1>
						{s.name !== null && (
							<code className="text-sm text-muted-foreground">{s.slug}</code>
						)}
						<div className="ml-auto">
							<RowActions teamId={teamId} sandbox={s} />
						</div>
					</div>
					<dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-y-1 text-sm">
						<dt className="text-muted-foreground">State</dt>
						<dd>
							<StateCell sandbox={s} />
						</dd>
						<dt className="text-muted-foreground">Health</dt>
						<dd>
							<HealthCell sandbox={s} />
						</dd>
						<dt className="text-muted-foreground">Template</dt>
						<dd>
							{s.template}
							{s.templateVersion ? ` (${s.templateVersion})` : ""}
						</dd>
						<dt className="text-muted-foreground">Size</dt>
						<dd>
							{s.size} · {s.vcpu} vCPU · {s.memoryMb} MB
						</dd>
						<dt className="text-muted-foreground">Created</dt>
						<dd>{formatTime(s.createdAt)}</dd>
					</dl>
				</>
			)}
		</section>
	);
}

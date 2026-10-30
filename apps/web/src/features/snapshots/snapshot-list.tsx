"use client";
// /app/t/<team>/snapshots (S8 §9.7): saved snapshots of the team from
// GET /v1/snapshots; "Create sandbox" opens the create form with the
// snapshot chosen; Delete asks first. Saving happens on the sandbox page.
import type { SnapshotData } from "@sbx/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { QueryError } from "@/components/app/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { newSandboxHref } from "@/lib/create-form";
import { formatAgo } from "@/lib/format";
import { POLL_MS, POLL_RETRY_BUDGET_MS } from "@/lib/sandboxes";
import { sandboxHref } from "../sandboxes/links";

const CONSISTENCY: Record<string, string> = {
	quiesced: "quiesced (running VM, filesystems frozen)",
	powered_off: "powered off",
	crash: "crash-consistent",
};

export function SnapshotList({ teamId }: { teamId: string }) {
	const sbx = useSbx(teamId);
	const queryClient = useQueryClient();
	const snapshots = useQuery({
		queryKey: ["snapshots", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await sbx.raw.GET("/v1/snapshots", {
				signal,
				retryBudgetMs: POLL_RETRY_BUDGET_MS,
			});
			return data.data;
		},
		// Poll only while one is being saved or deleted.
		refetchInterval: (q) =>
			(q.state.data ?? []).some(
				(s) => s.state === "creating" || s.state === "deleting",
			)
				? POLL_MS
				: false,
		refetchIntervalInBackground: false,
	});
	const limits = useQuery({
		queryKey: ["limits", teamId],
		queryFn: ({ signal }) => sbx.limits({ signal }),
	});

	const remove = async (s: SnapshotData): Promise<boolean> => {
		const r = await attempt(async () => {
			await sbx.snapshots.delete(s.name);
			return true;
		});
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["snapshots", teamId] }),
			queryClient.invalidateQueries({ queryKey: ["limits", teamId] }),
		]);
		if (r) toast.success(`Deleted ${s.name}`);
		return r === true;
	};

	const now = Date.now();
	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<h1 className="text-xl font-semibold">Saved snapshots</h1>
				{limits.data && (
					<p className="text-sm text-muted-foreground">
						{limits.data.usage.savedSnapshots} of{" "}
						{limits.data.quota.maxSavedSnapshots} saved
					</p>
				)}
			</div>
			<p className="text-sm text-muted-foreground">
				Save a snapshot from a sandbox's page. A snapshot belongs to this team
				only.
			</p>
			{snapshots.isError && (
				<QueryError
					error={snapshots.error}
					what="snapshots"
					onRetry={() => snapshots.refetch()}
				/>
			)}
			{snapshots.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{snapshots.data && snapshots.data.length === 0 && (
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No saved snapshots yet.
				</div>
			)}
			{snapshots.data && snapshots.data.length > 0 && (
				<Table data-testid="snapshot-table">
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>State</TableHead>
							<TableHead>Source</TableHead>
							<TableHead>Template</TableHead>
							<TableHead>Size</TableHead>
							<TableHead>Consistency</TableHead>
							<TableHead>Created</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{snapshots.data.map((s) => (
							<TableRow key={s.id} data-testid="snapshot-row">
								<TableCell className="font-medium">{s.name}</TableCell>
								<TableCell>
									<SnapshotState snapshot={s} />
								</TableCell>
								<TableCell>
									{s.sourceSandboxId ? (
										<Link
											href={sandboxHref(teamId, s.sourceSandboxId)}
											className="font-mono text-xs hover:underline"
										>
											{s.sourceSandboxId}
										</Link>
									) : (
										"—"
									)}
								</TableCell>
								<TableCell>
									{s.template ?? "—"}
									{s.templateVersion && (
										<div className="text-xs text-muted-foreground">
											{s.templateVersion}
										</div>
									)}
								</TableCell>
								<TableCell>{s.size ?? "—"}</TableCell>
								<TableCell className="text-muted-foreground">
									{s.consistency
										? (CONSISTENCY[s.consistency] ?? s.consistency)
										: "—"}
								</TableCell>
								<TableCell>{formatAgo(s.createdAt, now)}</TableCell>
								<TableCell>
									<div className="flex justify-end gap-1">
										{s.state === "ready" && (
											<Button asChild size="xs" variant="outline">
												<Link
													href={newSandboxHref(teamId, { snapshot: s.name })}
												>
													Create sandbox
												</Link>
											</Button>
										)}
										{s.state !== "deleting" && (
											<ConfirmButton
												title={`Delete snapshot ${s.name}?`}
												description="Sandboxes created from it keep running. This cannot be undone."
												confirmLabel="Delete"
												variant="ghost"
												size="xs"
												onConfirm={() => remove(s)}
											>
												Delete
											</ConfirmButton>
										)}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

function SnapshotState({ snapshot: s }: { snapshot: SnapshotData }) {
	if (s.state === "creating" || s.state === "deleting") {
		return (
			<span className="inline-flex items-center gap-1">
				<LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
				{s.state}
			</span>
		);
	}
	if (s.state === "failed") {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span>
						<Badge variant="destructive">failed</Badge>
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-72">
					{s.error ? `${s.error.code}: ${s.error.message}` : "Saving failed."}
				</TooltipContent>
			</Tooltip>
		);
	}
	return <span className="text-emerald-700">{s.state}</span>;
}

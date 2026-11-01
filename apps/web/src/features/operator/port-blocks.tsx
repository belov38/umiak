"use client";
// Hosted ports of one sandbox in the operator list (S8 §9.10, C3): Block /
// Unblock per port. Read with Sbx-Team of the sandbox's team.
import type { SandboxData } from "@sbx/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryError } from "@/components/app/query-error";
import { Button } from "@/components/ui/button";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { BlockDialog, UnblockDialog } from "./block-dialog";

// Kept after closing (open: false), so the title does not change mid-animation.
type Dialog = { kind: "block" | "unblock"; port: number; open: boolean } | null;

export function PortBlocks({ sandbox }: { sandbox: SandboxData }) {
	const sbx = useSbx(sandbox.teamId);
	const queryClient = useQueryClient();
	const key = ["ports", sandbox.teamId, sandbox.id] as const;
	const ports = useQuery({
		queryKey: key,
		queryFn: async ({ signal }) => {
			const { data } = await sbx.raw.GET("/v1/sandboxes/{sandbox}/ports", {
				params: { path: { sandbox: sandbox.id } },
				signal,
			});
			return data;
		},
	});
	const [dialog, setDialog] = useState<Dialog>(null);
	const path = (port: number) => ({
		params: { path: { sandbox: sandbox.id, port } },
	});
	const done = async (r: unknown, text: string) => {
		await queryClient.invalidateQueries({ queryKey: key });
		if (r === undefined) return false;
		toast.success(text);
		return true;
	};

	if (ports.isError) {
		return (
			<QueryError
				error={ports.error}
				what="ports"
				onRetry={() => ports.refetch()}
			/>
		);
	}
	if (!ports.data) {
		return <p className="text-sm text-muted-foreground">Loading ports…</p>;
	}
	const hosted = ports.data.hosted;
	return (
		<div className="space-y-2" data-testid="operator-ports">
			{hosted.length === 0 ? (
				<p className="text-sm text-muted-foreground">No published ports.</p>
			) : (
				<ul className="divide-y rounded-lg border bg-background">
					{hosted.map((p) => (
						<li
							key={p.port}
							className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm"
						>
							<span className="w-16 font-mono">{p.port}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
								{p.url}
							</span>
							<span className="text-xs text-muted-foreground">{p.access}</span>
							{p.blocked && (
								<span className="inline-flex items-center gap-1 text-xs text-warning">
									<LockIcon className="size-3.5" />
									blocked{p.blockReason ? ` (${p.blockReason})` : ""}
								</span>
							)}
							{p.blocked ? (
								<Button
									size="xs"
									variant="outline"
									onClick={() =>
										setDialog({ kind: "unblock", port: p.port, open: true })
									}
								>
									Unblock…
								</Button>
							) : (
								<Button
									size="xs"
									variant="outline"
									onClick={() =>
										setDialog({ kind: "block", port: p.port, open: true })
									}
								>
									Block…
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<BlockDialog
				open={dialog?.kind === "block" && dialog.open}
				onOpenChange={(o) => !o && setDialog((d) => d && { ...d, open: false })}
				title={`Block port ${dialog?.port ?? ""} of ${sandbox.slug}?`}
				description="The gateway refuses the port at once; the team cannot change, rotate or unpublish it until an operator unblocks it."
				onBlock={async (body) => {
					if (dialog === null) return false;
					const port = dialog.port;
					const r = await attempt(() =>
						sbx.raw.POST("/v1/sandboxes/{sandbox}/ports/{port}/block", {
							...path(port),
							body,
						}),
					);
					return done(r, `Port ${port} blocked`);
				}}
			/>
			<UnblockDialog
				open={dialog?.kind === "unblock" && dialog.open}
				onOpenChange={(o) => !o && setDialog((d) => d && { ...d, open: false })}
				title={`Unblock port ${dialog?.port ?? ""} of ${sandbox.slug}?`}
				onUnblock={async (body) => {
					if (dialog === null) return false;
					const port = dialog.port;
					const r = await attempt(() =>
						sbx.raw.POST("/v1/sandboxes/{sandbox}/ports/{port}/unblock", {
							...path(port),
							body,
						}),
					);
					return done(r, `Port ${port} unblocked`);
				}}
			/>
		</div>
	);
}

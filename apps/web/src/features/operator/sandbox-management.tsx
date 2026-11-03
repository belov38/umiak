"use client";
import { useQueryClient } from "@tanstack/react-query";
import type { SandboxData } from "@umiak/sdk";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useUmiak } from "@/lib/api";
import { useAttempt } from "@/lib/client-call";
import { canDelete } from "@/lib/sandboxes";
import { BlockDialog, UnblockDialog } from "./block-dialog";
import { PortBlocks } from "./port-blocks";

/** Single-owner deployment controls live beside the sandbox, without a second list. */
export function SandboxManagement({ sandbox }: { sandbox: SandboxData }) {
	const attempt = useAttempt();
	const umiak = useUmiak(sandbox.teamId);
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<"block" | "unblock" | null>(null);
	const [ports, setPorts] = useState(false);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["sandboxes", sandbox.teamId] });
	return (
		<section
			className="border bg-muted/20 p-4 space-y-3"
			aria-label="Sandbox management"
		>
			<div className="flex flex-wrap items-center gap-3">
				<h2 className="font-semibold">Access controls</h2>
				<Button
					variant="outline"
					size="sm"
					disabled={!canDelete(sandbox)}
					onClick={() => setDialog(sandbox.blocked ? "unblock" : "block")}
				>
					{sandbox.blocked ? "Unblock sandbox…" : "Block sandbox…"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					aria-expanded={ports}
					onClick={() => setPorts(!ports)}
				>
					Manage port access
				</Button>
			</div>
			{ports && <PortBlocks sandbox={sandbox} />}
			<BlockDialog
				open={dialog === "block"}
				onOpenChange={(open) => !open && setDialog(null)}
				title={`Block ${sandbox.slug}?`}
				description="Its ports and SSH are refused immediately and open terminals end. You can still read, stop and delete the sandbox."
				onBlock={async (body) => {
					const result = await attempt(() =>
						umiak.raw.POST("/v1/sandboxes/{sandbox}/block", {
							params: { path: { sandbox: sandbox.id } },
							body,
						}),
					);
					await refresh();
					if (result === undefined) return false;
					toast.success(`${sandbox.slug} blocked`);
					return true;
				}}
			/>
			<UnblockDialog
				open={dialog === "unblock"}
				onOpenChange={(open) => !open && setDialog(null)}
				title={`Unblock ${sandbox.slug}?`}
				onUnblock={async (body) => {
					const result = await attempt(() =>
						umiak.raw.POST("/v1/sandboxes/{sandbox}/unblock", {
							params: { path: { sandbox: sandbox.id } },
							body,
						}),
					);
					await refresh();
					if (result === undefined) return false;
					toast.success(`${sandbox.slug} unblocked`);
					return true;
				}}
			/>
		</section>
	);
}

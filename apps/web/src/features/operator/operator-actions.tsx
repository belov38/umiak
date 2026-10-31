"use client";
// Actions of a sandbox in the operator list (S8 §9.10): Block / Unblock
// (reason and note), Stop, Delete, open its page. Every request carries
// Sbx-Team of the sandbox's team (S7 §7.4); block/unblock need no team but
// get it too.
import type { SandboxData } from "@sbx/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DeleteSandboxDialog } from "@/features/sandboxes/delete-dialog";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { canDelete, canStop } from "@/lib/sandboxes";
import { BlockDialog, UnblockDialog } from "./block-dialog";

export const OPERATOR_SANDBOXES_KEY = "operator-sandboxes";

export function OperatorActions({
	sandbox,
	portsOpen,
	onTogglePorts,
}: {
	sandbox: SandboxData;
	portsOpen: boolean;
	onTogglePorts: () => void;
}) {
	const sbx = useSbx(sandbox.teamId);
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<"block" | "unblock" | "delete" | null>(
		null,
	);
	const path = { params: { path: { sandbox: sandbox.id } } };

	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: [OPERATOR_SANDBOXES_KEY] }),
			queryClient.invalidateQueries({
				queryKey: ["sandboxes", sandbox.teamId],
			}),
		]);
	const close = (o: boolean) => !o && setDialog(null);

	const stop = async () => {
		setBusy(true);
		const r = await attempt(() =>
			sbx.raw.POST("/v1/sandboxes/{sandbox}/stop", path),
		);
		setBusy(false);
		await refresh();
		if (r !== undefined) toast.success(`Stopping ${sandbox.slug}`);
	};

	return (
		<div className="flex items-center justify-end gap-1">
			<Button
				size="xs"
				variant="ghost"
				aria-expanded={portsOpen}
				onClick={onTogglePorts}
			>
				Ports
			</Button>
			{sandbox.blocked ? (
				<Button
					size="xs"
					variant="outline"
					disabled={busy}
					onClick={() => setDialog("unblock")}
				>
					Unblock…
				</Button>
			) : (
				<Button
					size="xs"
					variant="outline"
					disabled={busy || !canDelete(sandbox)}
					onClick={() => setDialog("block")}
				>
					Block…
				</Button>
			)}
			<Button
				size="xs"
				variant="outline"
				disabled={busy || !canStop(sandbox)}
				onClick={stop}
			>
				Stop
			</Button>
			<Button
				size="xs"
				variant="outline"
				className="text-destructive"
				disabled={busy || !canDelete(sandbox)}
				onClick={() => setDialog("delete")}
			>
				Delete…
			</Button>
			<BlockDialog
				open={dialog === "block"}
				onOpenChange={close}
				title={`Block ${sandbox.slug}?`}
				description="Its ports and SSH are refused at once, open terminals and streams end; the team can only read, stop and delete it until an operator unblocks it."
				onBlock={async (body) => {
					const r = await attempt(() =>
						sbx.raw.POST("/v1/sandboxes/{sandbox}/block", { ...path, body }),
					);
					await refresh();
					if (r === undefined) return false;
					toast.success(`${sandbox.slug} blocked`);
					return true;
				}}
			/>
			<UnblockDialog
				open={dialog === "unblock"}
				onOpenChange={close}
				title={`Unblock ${sandbox.slug}?`}
				onUnblock={async (body) => {
					const r = await attempt(() =>
						sbx.raw.POST("/v1/sandboxes/{sandbox}/unblock", {
							...path,
							body,
						}),
					);
					await refresh();
					if (r === undefined) return false;
					toast.success(`${sandbox.slug} unblocked`);
					return true;
				}}
			/>
			<DeleteSandboxDialog
				teamId={sandbox.teamId}
				sandbox={sandbox}
				open={dialog === "delete"}
				onOpenChange={close}
				onDeleted={async () => {
					toast.success(`Deleting ${sandbox.slug}`);
					await refresh();
				}}
			/>
		</div>
	);
}

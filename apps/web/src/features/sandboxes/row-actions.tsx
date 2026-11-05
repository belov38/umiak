"use client";
import { useQueryClient } from "@tanstack/react-query";
// Row/card actions (S8 §9.4): open detail, plus a menu for Stop/Resume,
// Fork, terminal and Delete. Operator blocks keep read/stop/delete available;
// successful mutations refresh both the list and quota.
import type { SandboxData } from "@umiak/sdk";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Link from "@/components/ui/link";
import { useUmiak } from "@/lib/api";
import { useAttempt } from "@/lib/client-call";
import { canDelete, canFork, canResume, canStop } from "@/lib/sandboxes";
import { DeleteSandboxDialog } from "./delete-dialog";
import { sandboxHref } from "./links";
import { useFork } from "./use-fork";

/** Refreshes what an action on a sandbox changes. */
export function useRefreshSandboxes(teamId: string) {
	const queryClient = useQueryClient();
	return async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["sandboxes", teamId] }),
			queryClient.invalidateQueries({ queryKey: ["limits", teamId] }),
		]);
	};
}

export function RowActions({
	teamId,
	sandbox,
}: {
	teamId: string;
	sandbox: SandboxData;
}) {
	const attempt = useAttempt();
	const umiak = useUmiak(teamId);
	const refresh = useRefreshSandboxes(teamId);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const path = { params: { path: { sandbox: sandbox.id } } };

	const run = async <T,>(
		fn: () => Promise<T>,
		done?: string,
	): Promise<T | undefined> => {
		setBusy(true);
		const r = await attempt(fn);
		setBusy(false);
		await refresh();
		if (r !== undefined && done) toast.success(done);
		return r;
	};

	const stop = () =>
		run(
			() => umiak.raw.POST("/v1/sandboxes/{sandbox}/stop", path),
			`Stopping ${sandbox.slug}`,
		);
	const resume = () =>
		run(
			() =>
				umiak.raw.POST("/v1/sandboxes/{sandbox}/resume", { ...path, body: {} }),
			`Resuming ${sandbox.slug}`,
		);
	const forking = useFork(teamId, sandbox, refresh);
	const fork = async () => {
		setBusy(true);
		try {
			await forking.fork();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="sandbox-row-actions flex items-center justify-end gap-1">
			<Button asChild size="icon-sm" variant="ghost">
				<Link
					href={sandboxHref(teamId, sandbox.slug)}
					aria-label={`Open ${sandbox.name ?? sandbox.slug}`}
				>
					<ChevronRightIcon />
				</Link>
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={`Actions of ${sandbox.slug}`}
						disabled={busy}
					>
						<EllipsisIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
					{canStop(sandbox) && (
						<DropdownMenuItem disabled={busy} onSelect={stop}>
							Stop
						</DropdownMenuItem>
					)}
					{sandbox.state === "stopped" && (
						<DropdownMenuItem
							disabled={busy || !canResume(sandbox)}
							title={
								sandbox.blocked ? "Blocked by a platform operator" : undefined
							}
							onSelect={resume}
						>
							Resume
							{sandbox.blocked && (
								<span className="text-xs text-muted-foreground">
									Blocked by a platform operator
								</span>
							)}
						</DropdownMenuItem>
					)}

					<DropdownMenuItem disabled={!canFork(sandbox)} onSelect={fork}>
						Fork
					</DropdownMenuItem>
					{sandbox.state === "ready" && !sandbox.blocked ? (
						<DropdownMenuItem asChild>
							<Link href={sandboxHref(teamId, sandbox.slug, "terminal")}>
								Open terminal
							</Link>
						</DropdownMenuItem>
					) : (
						// No link at all: a disabled item must not navigate.
						<DropdownMenuItem disabled>Open terminal</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						disabled={!canDelete(sandbox)}
						onSelect={() => setDeleting(true)}
					>
						Delete…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{forking.dialog}
			<DeleteSandboxDialog
				teamId={teamId}
				sandbox={sandbox}
				open={deleting}
				onOpenChange={setDeleting}
				onDeleted={async () => {
					toast.success(`Deleting ${sandbox.slug}`);
					await refresh();
				}}
			/>
		</div>
	);
}

"use client";
import { useQueryClient } from "@tanstack/react-query";
// Actions of a sandbox row (S8 §9.4): Stop / Resume by state, and a menu
// with Fork, Open terminal, Delete. A blocked sandbox keeps stop and delete
// only (S8 §11): Resume, Fork and Open terminal are disabled. After an action the list and the quota refresh at once.
import type { SandboxData } from "@umiak/sdk";
import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
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
import { useUmiak } from "@/lib/api";
import { attempt } from "@/lib/client-call";
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
		<div className="flex items-center justify-end gap-1">
			{canStop(sandbox) && (
				<Button size="xs" variant="outline" disabled={busy} onClick={stop}>
					Stop
				</Button>
			)}
			{sandbox.state === "stopped" && (
				<Button
					size="xs"
					variant="outline"
					disabled={busy || !canResume(sandbox)}
					title={sandbox.blocked ? "Blocked by a platform operator" : undefined}
					onClick={resume}
				>
					Resume
				</Button>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label={`Actions of ${sandbox.slug}`}
						disabled={busy}
					>
						<EllipsisIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
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

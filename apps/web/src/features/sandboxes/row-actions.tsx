"use client";
// Actions of a sandbox row (S8 §9.4): Stop / Resume by state, and a menu
// with Fork, Open terminal, Delete. A blocked sandbox keeps stop and delete
// only (S8 §11): Resume, Fork and Open terminal are disabled. After an action the list and the quota refresh at once.
import type { SandboxData } from "@sbx/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { canDelete, canFork, canResume, canStop } from "@/lib/sandboxes";
import { DeleteSandboxDialog } from "./delete-dialog";
import { sandboxHref } from "./links";

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
	const sbx = useSbx(teamId);
	const router = useRouter();
	const refresh = useRefreshSandboxes(teamId);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const forkKey = useRef<IdempotencySlot | null>(null);
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
			() => sbx.raw.POST("/v1/sandboxes/{sandbox}/stop", path),
			`Stopping ${sandbox.slug}`,
		);
	const resume = () =>
		run(
			() =>
				sbx.raw.POST("/v1/sandboxes/{sandbox}/resume", { ...path, body: {} }),
			`Resuming ${sandbox.slug}`,
		);
	const fork = async () => {
		const body = {};
		// One key per source sandbox and body until the outcome is known, so
		// a second click after a lost answer cannot make a second copy.
		const slot = slotFor(forkKey.current, { sandbox: sandbox.id, body });
		setBusy(true);
		let slug: string;
		try {
			const { data } = await sbx.raw.POST("/v1/sandboxes/{sandbox}/fork", {
				...path,
				body,
				idempotencyKey: slot.key,
			});
			forkKey.current = slotAfter(slot, undefined);
			slug = data.sandbox.slug;
		} catch (e) {
			forkKey.current = slotAfter(slot, e);
			toast.error(describeError(e).message);
			return;
		} finally {
			setBusy(false);
			await attempt(refresh);
		}
		toast.success(`Forking ${sandbox.slug} into ${slug}`);
		router.push(sandboxHref(teamId, slug));
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

"use client";
// Fork of a sandbox from the list row and the sandbox page (S8 §9.4, §9.6).
// One Idempotency-Key per source sandbox and body until the outcome is
// known (src/lib/idempotency.ts), so a second click after a lost answer
// cannot make a second copy. Success → the copy's page. A running Windows
// sandbox is forked with `forceStop: true` after the user confirms the stop
// and restart (S9 §24.8): asked up front when the catalog says Windows,
// otherwise on the API's 409 `snapshot_requires_stop`. Render `dialog`.
import type { SandboxData } from "@sbx/sdk";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef } from "react";
import { toast } from "sonner";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { describeError, isSnapshotRequiresStop } from "@/lib/errors";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { useForceStopConfirm, useNeedsForceStop } from "./force-stop";
import { sandboxHref } from "./links";

export function useFork(
	teamId: string,
	sandbox: SandboxData,
	refresh: () => Promise<void>,
): { fork: () => Promise<void>; dialog: ReactNode } {
	const sbx = useSbx(teamId);
	const router = useRouter();
	const forkKey = useRef<IdempotencySlot | null>(null);
	const windows = useNeedsForceStop(teamId, sandbox);
	const confirm = useForceStopConfirm(`Fork ${sandbox.slug}?`, "Stop and fork");

	/** The copy's slug; undefined after an error (shown) or a 409 to confirm. */
	const post = async (
		forceStop: boolean,
	): Promise<string | "requires_stop" | undefined> => {
		const body = forceStop ? { forceStop: true } : {};
		const slot = slotFor(forkKey.current, { sandbox: sandbox.id, body });
		try {
			const { data } = await sbx.raw.POST("/v1/sandboxes/{sandbox}/fork", {
				params: { path: { sandbox: sandbox.id } },
				body,
				idempotencyKey: slot.key,
			});
			forkKey.current = slotAfter(slot, undefined);
			return data.sandbox.slug;
		} catch (e) {
			forkKey.current = slotAfter(slot, e);
			if (!forceStop && isSnapshotRequiresStop(e)) return "requires_stop";
			toast.error(describeError(e).message);
			return undefined;
		} finally {
			await attempt(refresh);
		}
	};

	const fork = async () => {
		if (windows && !(await confirm.ask())) return;
		let slug = await post(windows);
		if (slug === "requires_stop") {
			if (!(await confirm.ask())) return;
			slug = await post(true);
		}
		if (slug === undefined || slug === "requires_stop") return;
		toast.success(`Forking ${sandbox.slug} into ${slug}`);
		router.push(sandboxHref(teamId, slug));
	};
	return { fork, dialog: confirm.dialog };
}

"use client";
// Fork of a sandbox from the list row and the sandbox page (S8 §9.4, §9.6).
// One Idempotency-Key per source sandbox and body until the outcome is
// known (src/lib/idempotency.ts), so a second click after a lost answer
// cannot make a second copy. Success → the copy's page.
import type { SandboxData } from "@sbx/sdk";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { sandboxHref } from "./links";

export function useFork(
	teamId: string,
	sandbox: SandboxData,
	refresh: () => Promise<void>,
): () => Promise<void> {
	const sbx = useSbx(teamId);
	const router = useRouter();
	const forkKey = useRef<IdempotencySlot | null>(null);
	return async () => {
		const body = {};
		const slot = slotFor(forkKey.current, { sandbox: sandbox.id, body });
		let slug: string;
		try {
			const { data } = await sbx.raw.POST("/v1/sandboxes/{sandbox}/fork", {
				params: { path: { sandbox: sandbox.id } },
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
			await attempt(refresh);
		}
		toast.success(`Forking ${sandbox.slug} into ${slug}`);
		router.push(sandboxHref(teamId, slug));
	};
}

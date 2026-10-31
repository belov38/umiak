"use client";
// Consent to a forced fork or saved snapshot of a running Windows sandbox
// (S9 §24.8): the source is stopped for the snapshot and started again.
// `useNeedsForceStop` knows the OS from the template catalog; `ask()` opens
// the confirm dialog and resolves to the user's answer.
import type { SandboxData } from "@sbx/sdk";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useSbx } from "@/lib/api";
import { FORCE_STOP_TEXT, needsForceStop } from "../sandbox/rules";

/** The sandbox is a running Windows one (false while the catalog loads). */
export function useNeedsForceStop(teamId: string, s: SandboxData): boolean {
	const sbx = useSbx(teamId);
	const templates = useQuery({
		queryKey: ["templates", teamId],
		queryFn: ({ signal }) => sbx.templates({ signal }),
		staleTime: 5 * 60_000,
	});
	return needsForceStop(s, templates.data);
}

export function useForceStopConfirm(
	title: string,
	confirmLabel: string,
): { ask: () => Promise<boolean>; dialog: ReactNode } {
	const [answer, setAnswer] = useState<((ok: boolean) => void) | null>(null);
	const close = (ok: boolean) => {
		answer?.(ok);
		setAnswer(null);
	};
	const ask = () =>
		new Promise<boolean>((resolve) => {
			setAnswer(() => resolve);
		});
	const dialog = (
		<Dialog
			open={answer !== null}
			onOpenChange={(o) => {
				if (!o) close(false);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{FORCE_STOP_TEXT}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => close(false)}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={() => close(true)}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	return { ask, dialog };
}

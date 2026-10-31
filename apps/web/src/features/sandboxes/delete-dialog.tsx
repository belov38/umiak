"use client";
// Delete of a sandbox (S8 §9.4): confirmed by typing its slug; the request
// carries Sbx-Confirm-Delete with the sandbox id (S7 §5.12).
import type { SandboxData } from "@sbx/sdk";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";

export function DeleteSandboxDialog({
	teamId,
	sandbox,
	open,
	onOpenChange,
	onDeleted,
}: {
	teamId: string;
	sandbox: SandboxData;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted: () => void | Promise<void>;
}) {
	const sbx = useSbx(teamId);
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const matches = typed.trim() === sandbox.slug;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!matches) return;
		setBusy(true);
		const r = await attempt(() =>
			sbx.raw.DELETE("/v1/sandboxes/{sandbox}", {
				params: { path: { sandbox: sandbox.id } },
				headers: { "Sbx-Confirm-Delete": sandbox.id },
			}),
		);
		setBusy(false);
		if (r === undefined) return;
		setTyped("");
		onOpenChange(false);
		await onDeleted();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (busy) return;
				if (!o) setTyped("");
				onOpenChange(o);
			}}
		>
			<DialogContent>
				<form method="post" onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Delete {sandbox.slug}?</DialogTitle>
						<DialogDescription>
							The VM and everything on its disk are deleted; saved snapshots
							stay. This cannot be undone. Type the slug to confirm.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Slug of the sandbox to delete"
						placeholder={sandbox.slug}
						autoComplete="off"
						spellCheck={false}
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
					/>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="submit"
							variant="destructive"
							disabled={busy || !matches}
						>
							Delete
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

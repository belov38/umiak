"use client";
// A button that asks before it acts (remove, leave, revoke, delete).
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

export function ConfirmButton({
	title,
	description,
	confirmLabel,
	onConfirm,
	disabled,
	children,
	size = "sm",
	variant = "outline",
}: {
	title: string;
	description: ReactNode;
	confirmLabel: string;
	/** Resolves to true when done (the dialog closes). */
	onConfirm: () => Promise<boolean>;
	disabled?: boolean;
	children: ReactNode;
	size?: "sm" | "default" | "xs";
	variant?: "outline" | "destructive" | "ghost";
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
			<DialogTrigger asChild>
				<Button size={size} variant={variant} disabled={disabled}>
					{children}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button
						variant="destructive"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								if (await onConfirm()) setOpen(false);
							} finally {
								setBusy(false);
							}
						}}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

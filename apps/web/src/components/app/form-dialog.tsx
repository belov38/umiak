"use client";
// A small dialog with a form: fields as children, one submit button. The
// submit handler resolves to true when done (the dialog closes).
import { type FormEvent, type ReactNode, useId, useState } from "react";
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
import { FieldContext } from "@/components/ui/field-context";

export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	submitLabel,
	submitDisabled,
	destructive,
	onSubmit,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	submitLabel: string;
	submitDisabled?: boolean;
	destructive?: boolean;
	onSubmit: () => Promise<boolean>;
	children?: ReactNode;
}) {
	const [busy, setBusy] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (busy || submitDisabled) return;
		setBusy(true);
		try {
			if (await onSubmit()) onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent>
				<form method="post" onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description && (
							<DialogDescription>{description}</DialogDescription>
						)}
					</DialogHeader>
					{children}
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="submit"
							variant={destructive ? "destructive" : "default"}
							disabled={busy || submitDisabled}
						>
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A labelled field of a form dialog, with an optional error. */
export function Field({
	label,
	error,
	hint,
	required = false,
	children,
}: {
	label: string;
	error?: string | null | undefined;
	hint?: ReactNode;
	required?: boolean | undefined;
	children: ReactNode;
}) {
	const id = useId();
	const messageId = `${id}-message`;

	return (
		<FieldContext.Provider
			value={{
				id,
				messageId: error || hint ? messageId : undefined,
				invalid: Boolean(error),
				required,
			}}
		>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the child */}
			<label className="grid gap-1 text-sm">
				<span className="font-medium">
					{label}
					{required && <span aria-hidden="true"> *</span>}
				</span>
				{children}
				{hint && !error && (
					<span id={messageId} className="text-xs text-muted-foreground">
						{hint}
					</span>
				)}
				{error && (
					<span
						id={messageId}
						role="alert"
						className="text-xs text-destructive"
					>
						{error}
					</span>
				)}
			</label>
		</FieldContext.Provider>
	);
}

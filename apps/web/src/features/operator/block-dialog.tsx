"use client";
// Block of a sandbox or a port (S8 C3): reason `operator` or `abuse` and an
// optional note (≤ 500 characters, kept in the sandbox's events). Unblock
// takes an optional note only.
import { useState } from "react";
import { Field, FormDialog } from "@/components/app/form-dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
	BLOCK_REASONS,
	type BlockReason,
	blockBody,
	MAX_BLOCK_NOTE,
} from "@/lib/operator";

const REASON_TEXT: Record<BlockReason, string> = {
	operator: "operator: maintenance, policy",
	abuse: "abuse: misuse of the platform",
};

export function NoteInput({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<Textarea
			aria-label="Note"
			rows={3}
			maxLength={MAX_BLOCK_NOTE + 100}
			className="w-full rounded-none border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

export function BlockDialog({
	open,
	onOpenChange,
	title,
	description,
	onBlock,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	/** Resolves to true when done (the dialog closes). */
	onBlock: (body: { reason: BlockReason; note?: string }) => Promise<boolean>;
}) {
	const [reason, setReason] = useState<BlockReason>("operator");
	const [note, setNote] = useState("");
	const r = blockBody(reason, note);
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					setReason("operator");
					setNote("");
				}
				onOpenChange(o);
			}}
			title={title}
			description={description}
			submitLabel="Block"
			destructive
			submitDisabled={!r.ok}
			onSubmit={async () => (r.ok ? onBlock(r.body) : false)}
		>
			<Field label="Reason">
				<Select
					value={reason}
					onValueChange={(v) => setReason(v as BlockReason)}
				>
					<SelectTrigger aria-label="Reason" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{BLOCK_REASONS.map((b) => (
							<SelectItem key={b} value={b}>
								{REASON_TEXT[b]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field
				label="Note (optional)"
				error={r.ok ? null : r.error}
				hint={`Kept in the sandbox's events. ${note.trim().length}/${MAX_BLOCK_NOTE}`}
			>
				<NoteInput value={note} onChange={setNote} />
			</Field>
		</FormDialog>
	);
}

export function UnblockDialog({
	open,
	onOpenChange,
	title,
	onUnblock,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	onUnblock: (body: { note?: string }) => Promise<boolean>;
}) {
	const [note, setNote] = useState("");
	const n = note.trim();
	const tooLong = n.length > MAX_BLOCK_NOTE;
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => {
				if (!o) setNote("");
				onOpenChange(o);
			}}
			title={title}
			description="The restrictions are lifted at once."
			submitLabel="Unblock"
			submitDisabled={tooLong}
			onSubmit={() => onUnblock(n === "" ? {} : { note: n })}
		>
			<Field
				label="Note (optional)"
				error={tooLong ? `At most ${MAX_BLOCK_NOTE} characters` : null}
			>
				<NoteInput value={note} onChange={setNote} />
			</Field>
		</FormDialog>
	);
}

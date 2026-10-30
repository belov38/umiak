"use client";
// The secret of a new or rotated team key, shown once (S8 §9.8): copy
// button and the two ways to use it. The secret lives only in the state of
// the keys page and is dropped when this dialog closes.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { keyExamples } from "@/lib/api-keys";

export interface ShownSecret {
	keyName: string;
	secret: string;
	rotated: boolean;
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="button"
			size="icon-sm"
			variant="ghost"
			aria-label={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					toast.error("Could not copy: select the text and copy it yourself.");
				}
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

export function SecretDialog({
	shown,
	onClose,
}: {
	shown: ShownSecret | null;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={shown !== null}
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			{shown && (
				<DialogContent
					className="sm:max-w-2xl"
					data-testid="key-secret-dialog"
					// A click outside must not lose a secret that is shown only once.
					onInteractOutside={(e) => e.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle>
							{shown.rotated ? "New secret of" : "Key"} {shown.keyName}
						</DialogTitle>
						<DialogDescription>
							Copy the secret now: it is not shown again. Keep it like a
							password.
							{shown.rotated && " The old secret has stopped working."}
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-2">
						<code
							className="flex-1 font-mono text-xs break-all select-all"
							data-testid="key-secret"
						>
							{shown.secret}
						</code>
						<CopyButton text={shown.secret} label="Copy the secret" />
					</div>
					<div className="space-y-1.5">
						<p className="text-sm text-muted-foreground">
							In CI or an agent, as an environment variable; or save it for the
							CLI:
						</p>
						{keyExamples(shown.secret).map((line) => (
							<div
								key={line}
								className="flex items-center gap-1 rounded-lg border bg-muted/40 p-2"
							>
								<code className="flex-1 font-mono text-xs break-all">
									{line}
								</code>
								<CopyButton text={line} label="Copy the command" />
							</div>
						))}
					</div>
					<DialogFooter>
						<Button onClick={onClose}>I have copied it</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}

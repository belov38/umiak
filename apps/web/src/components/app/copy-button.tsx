"use client";
// Copies a text to the clipboard; a check mark for a moment after.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyFailureGuidance } from "@/lib/browser-guidance";
import { copyText } from "@/lib/clipboard";

export function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="button"
			size="icon-sm"
			variant="ghost"
			aria-label={label}
			title={label}
			onClick={async () => {
				try {
					await copyText(text);
					setCopied(true);
					toast.success("Copied");
					setTimeout(() => setCopied(false), 1500);
				} catch {
					toast.error(copyFailureGuidance());
				}
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

/** A monospace line with a copy button. */
export function CopyLine({ text, label }: { text: string; label: string }) {
	return (
		<div className="flex items-center gap-1 border bg-muted/40 p-2">
			<code className="min-w-0 flex-1 font-mono text-xs break-all select-all">
				{text}
			</code>
			<CopyButton text={text} label={label} />
		</div>
	);
}

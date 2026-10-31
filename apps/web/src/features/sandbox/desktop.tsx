"use client";
// Desktop tab (S8 §9.6): only for templates with the `desktop`
// capability. The desktop itself (and the iframe contract) comes with S10.
import { MonitorIcon } from "lucide-react";

export function DesktopTab() {
	return (
		<div
			data-testid="desktop-placeholder"
			className="flex aspect-video max-h-[70vh] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground"
		>
			<MonitorIcon className="size-8" />
			<p>Desktop arrives with S10.</p>
		</div>
	);
}

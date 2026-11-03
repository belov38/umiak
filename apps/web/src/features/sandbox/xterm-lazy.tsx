"use client";
// xterm.js touches `window` and `document` when it loads: client only.
import dynamic from "next/dynamic";

export type { XtermHandle, XtermViewProps } from "./xterm";

export const XtermView = dynamic(() => import("./xterm"), {
	ssr: false,
	loading: () => (
		<div className="flex h-full min-h-40 items-center justify-center rounded-none bg-[var(--terminal-background)] text-sm text-neutral-400">
			Loading terminal…
		</div>
	),
});

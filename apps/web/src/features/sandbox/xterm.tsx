"use client";
// xterm.js 6 with fit, web-links and search (S8 §9.6). Only ever loaded on
// the client through `xterm-lazy.tsx` (next/dynamic, ssr: false); the CSS
// comes from the package, not a CDN.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface XtermHandle {
	term: Terminal;
	/** Fits the terminal to its box (cols/rows change → term.onResize). */
	fit(): void;
}

export interface XtermViewProps {
	/** Output only: no cursor, keystrokes are not sent. */
	readOnly?: boolean;
	/** `\n` → `\r\n` (output of commands without a PTY). */
	convertEol?: boolean;
	/** Called once the terminal is open; its cleanup runs on unmount. */
	onReady: (h: XtermHandle) => undefined | (() => void);
	className?: string;
}

const THEME = {
	background: "#0b0d10",
	foreground: "#e6e6e6",
	cursor: "#e6e6e6",
	selectionBackground: "#3b4252",
};

export default function XtermView({
	readOnly = false,
	convertEol = false,
	onReady,
	className,
}: XtermViewProps) {
	const box = useRef<HTMLDivElement>(null);
	const ready = useRef(onReady);
	ready.current = onReady;
	const [search, setSearch] = useState<SearchAddon | null>(null);
	const [needle, setNeedle] = useState("");

	useEffect(() => {
		const el = box.current;
		if (el === null) return;
		const term = new Terminal({
			cursorBlink: !readOnly,
			disableStdin: readOnly,
			convertEol,
			scrollback: 10_000,
			fontSize: 13,
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
			theme: THEME,
		});
		const fitAddon = new FitAddon();
		const searchAddon = new SearchAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(new WebLinksAddon());
		term.open(el);
		const fit = () => {
			// A hidden box has no size; fitting it would give 0 columns.
			if (el.clientWidth > 0 && el.clientHeight > 0) {
				try {
					fitAddon.fit();
				} catch {
					// not rendered yet
				}
			}
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		setSearch(searchAddon);
		const cleanup = ready.current({ term, fit });
		return () => {
			cleanup?.();
			ro.disconnect();
			setSearch(null);
			term.dispose();
		};
	}, [readOnly, convertEol]);

	return (
		<div className={cn("flex min-h-0 flex-col gap-1", className)}>
			<div className="flex items-center justify-end gap-1">
				<Input
					aria-label="Search in the output"
					placeholder="Search"
					className="h-7 w-48"
					value={needle}
					onChange={(e) => {
						setNeedle(e.target.value);
						if (e.target.value === "") search?.clearDecorations();
						else search?.findNext(e.target.value, { incremental: true });
					}}
					onKeyDown={(e) => {
						if (e.key !== "Enter" || needle === "") return;
						e.preventDefault();
						if (e.shiftKey) search?.findPrevious(needle);
						else search?.findNext(needle);
					}}
				/>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Previous match"
					disabled={needle === ""}
					onClick={() => search?.findPrevious(needle)}
				>
					<ChevronUpIcon />
				</Button>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Next match"
					disabled={needle === ""}
					onClick={() => search?.findNext(needle)}
				>
					<ChevronDownIcon />
				</Button>
			</div>
			<div
				ref={box}
				data-testid="xterm"
				className="min-h-0 flex-1 overflow-hidden rounded-lg bg-[#0b0d10] p-1"
			/>
		</div>
	);
}

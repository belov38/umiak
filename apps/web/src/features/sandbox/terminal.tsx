"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// Terminal tab (S8 §9.6): terminals of the sandbox as tabs. "New terminal"
// → POST /ptys (Idempotency-Key), then the PTY WebSocket through the SDK
// (`/api/v1/sandboxes/{sb}/ptys/{cmd}/connect?team=…`, umiak.pty.v1). The
// running terminals (GET /commands?mode=pty&status=running) come back as
// tabs after a reload and attach with 64 KiB of scrollback. Only the open
// tab holds a WebSocket; leaving the tab or the page closes it (the shell
// keeps running). The SDK reconnects by offset; meanwhile a
// "reconnecting…" bar. Detach leaves the shell running (the agent ends it
// after 10 min without a client); Close ends it (kill).
import type { CommandData, Pty, Sandbox, SandboxData } from "@umiak/sdk";
import { LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { watchPtySocket } from "@/lib/ws";
import { exitText } from "./output";
import {
	closeCodeText,
	mergeRunningTabs,
	PTY_TAIL_BYTES,
	type PtyFailure,
	type PtyPhase,
	ptyFailure,
	ptyTitle,
	type TermTabState,
} from "./pty-status";
import { canWork } from "./rules";
import { type XtermHandle, XtermView } from "./xterm-lazy";

/** Time to the answer of POST /ptys: the api waits up to 60 s for a starting sandbox. */
const START_TIMEOUT_MS = 75_000;
const START_RETRY_BUDGET_MS = 15_000;

type TermTab = TermTabState;

/**
 * Terminals closed on this page (`cmd_…`, unique across sandboxes); kept
 * across remounts of the tab while their kill settles.
 */
const dismissedPtys = new Set<string>();

export function TerminalTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const queryClient = useQueryClient();
	const gate = canWork(sandbox);
	const key = ["ptys", teamId, sandbox.id] as const;
	const running = useQuery({
		queryKey: key,
		queryFn: async ({ signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/commands",
				{
					params: {
						path: { sandbox: sandbox.id },
						query: { mode: "pty", status: "running", limit: 50 },
					},
					signal,
				},
			);
			return data.data;
		},
		enabled: gate.ok,
	});
	const [tabs, setTabs] = useState<TermTab[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	// Running terminals the page does not show yet become tabs (not the
	// ones closed here: a killed shell may be listed as running a moment).
	useEffect(() => {
		const list = running.data;
		if (!list) return;
		setTabs((cur) => mergeRunningTabs(cur, list, dismissedPtys));
		setActive(
			(a) => a ?? list.find((c) => !dismissedPtys.has(c.id))?.id ?? null,
		);
	}, [running.data]);

	const create = async () => {
		setCreating(true);
		const r = await attempt(() =>
			handle.core.raw.POST("/v1/sandboxes/{sandbox}/ptys", {
				params: { path: { sandbox: sandbox.id } },
				body: { cols: 120, rows: 32, term: "xterm-256color" },
				timeoutMs: START_TIMEOUT_MS,
				retryBudgetMs: START_RETRY_BUDGET_MS,
			}),
		);
		setCreating(false);
		if (r === undefined) return;
		const c = r.data as CommandData;
		setTabs((cur) => [
			...cur,
			{ id: c.id, command: c.command, detached: false },
		]);
		setActive(c.id);
	};

	const remove = useCallback(
		(id: string) => {
			dismissedPtys.add(id);
			setTabs((cur) => {
				const next = cur.filter((t) => t.id !== id);
				setActive((a) => (a === id ? (next[0]?.id ?? null) : a));
				return next;
			});
			void queryClient.invalidateQueries({ queryKey: ["ptys", teamId] });
		},
		[queryClient, teamId],
	);
	const setDetached = useCallback((id: string, detached: boolean) => {
		setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, detached } : t)));
	}, []);

	if (!gate.ok) {
		return <p className="text-sm text-muted-foreground">{gate.reason}</p>;
	}
	const current = tabs.find((t) => t.id === active) ?? null;
	return (
		<div className="flex h-[70vh] min-h-80 flex-col gap-2">
			<div className="flex flex-wrap items-center gap-1" role="tablist">
				{tabs.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={t.id === active}
						className={cn(
							"rounded-md border px-2 py-1 font-mono text-xs",
							t.id === active
								? "bg-muted font-medium"
								: "text-muted-foreground",
						)}
						onClick={() => setActive(t.id)}
					>
						{ptyTitle(t)}
						{t.detached && " (detached)"}
					</button>
				))}
				<Button
					size="sm"
					variant="outline"
					disabled={creating}
					onClick={create}
				>
					{creating ? (
						<LoaderCircleIcon className="animate-spin" />
					) : (
						<PlusIcon />
					)}
					New terminal
				</Button>
				{running.isPending && (
					<span className="text-xs text-muted-foreground">
						Looking for open terminals…
					</span>
				)}
				{running.isError && (
					<span className="text-xs text-destructive">
						Could not list open terminals:{" "}
						{describeError(running.error).message}
					</span>
				)}
			</div>
			{current === null ? (
				<div className="flex flex-1 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
					No terminal open. “New terminal” starts a login shell.
				</div>
			) : current.detached ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
					<p>
						Detached: the shell keeps running. The agent ends it after 10 min
						without a client.
					</p>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setDetached(current.id, false)}
					>
						Reattach
					</Button>
				</div>
			) : (
				<TerminalSession
					key={current.id}
					handle={handle}
					commandId={current.id}
					onDetach={() => setDetached(current.id, true)}
					onClosed={() => remove(current.id)}
				/>
			)}
		</div>
	);
}

function TerminalSession({
	handle,
	commandId,
	onDetach,
	onClosed,
}: {
	handle: Sandbox;
	commandId: string;
	onDetach: () => void;
	onClosed: () => void;
}) {
	const [phase, setPhase] = useState<PtyPhase>("connecting");
	const [why, setWhy] = useState<string | null>(null);
	const [failure, setFailure] = useState<PtyFailure | null>(null);
	const [exit, setExit] = useState<string | null>(null);
	const [attemptNo, setAttemptNo] = useState(0);
	const [closing, setClosing] = useState(false);
	const ptyRef = useRef<Pty | null>(null);

	useEffect(
		() =>
			watchPtySocket(commandId, (e) => {
				if (e.type === "attached") {
					setPhase((p) => (p === "exited" || p === "failed" ? p : "attached"));
					setWhy(null);
				} else {
					setPhase((p) => (p === "attached" ? "reconnecting" : p));
					setWhy(closeCodeText(e.code));
				}
			}),
		[commandId],
	);

	const onReady = useCallback(
		({ term, fit }: XtermHandle) => {
			const ac = new AbortController();
			const subs: { dispose(): void }[] = [];
			const offs: (() => void)[] = [];
			setPhase("connecting");
			setFailure(null);
			setExit(null);
			term.focus();
			void handle
				.connectPty(commandId, { tailBytes: PTY_TAIL_BYTES, signal: ac.signal })
				.then((pty) => {
					if (ac.signal.aborted) {
						pty.close();
						return;
					}
					ptyRef.current = pty;
					offs.push(pty.onData((b) => term.write(b)));
					offs.push(
						pty.onTruncated(() =>
							term.write("\r\n\x1b[2m… earlier output was lost\x1b[0m\r\n"),
						),
					);
					subs.push(
						term.onData((d) => {
							try {
								pty.write(d);
							} catch (e) {
								toast.error(describeError(e).message);
							}
						}),
					);
					subs.push(term.onResize(({ cols, rows }) => pty.resize(cols, rows)));
					fit();
					pty.resize(term.cols, term.rows);
					setPhase("attached");
					return pty.exited.then((x) => {
						const text = exitText(x);
						term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
						setExit(text);
						setPhase("exited");
					});
				})
				.catch((e: unknown) => {
					if (ac.signal.aborted) return;
					setFailure(ptyFailure(e));
					setPhase("failed");
				});
			return () => {
				ac.abort();
				for (const s of subs) s.dispose();
				for (const off of offs) off();
				ptyRef.current = null;
			};
		},
		// "Reconnect" (attemptNo) remounts the terminal: a new connection.
		[handle, commandId],
	);

	const close = async () => {
		setClosing(true);
		const r = await attempt(() =>
			handle.command(commandId).kill({ graceMs: 2000 }),
		);
		setClosing(false);
		if (r === undefined) return;
		ptyRef.current?.close();
		onClosed();
	};

	const status = useMemo(() => {
		switch (phase) {
			case "connecting":
				return "Connecting…";
			case "attached":
				return null;
			case "reconnecting":
				return `Reconnecting…${why ? ` (${why})` : ""}`;
			case "exited":
				return `The shell ended ${exit ?? ""}`;
			case "failed":
				return failure?.message ?? "Disconnected.";
		}
	}, [phase, why, exit, failure]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				{status && (
					<span
						role="status"
						data-testid="pty-status"
						className={cn(
							"flex items-center gap-1 rounded px-2 py-0.5",
							phase === "failed"
								? "bg-destructive/10 text-destructive"
								: "bg-warning-tint text-warning",
						)}
					>
						{(phase === "connecting" || phase === "reconnecting") && (
							<LoaderCircleIcon className="size-3.5 animate-spin" />
						)}
						{status}
					</span>
				)}
				{phase === "failed" && failure?.retry && (
					<Button
						size="xs"
						variant="outline"
						onClick={() => setAttemptNo((n) => n + 1)}
					>
						Reconnect
					</Button>
				)}
				<div className="ml-auto flex items-center gap-1">
					{phase === "exited" || (phase === "failed" && !failure?.retry) ? (
						<Button size="xs" variant="outline" onClick={onClosed}>
							<XIcon /> Close tab
						</Button>
					) : (
						<>
							<Button
								size="xs"
								variant="outline"
								title="Disconnect; the shell keeps running. The agent ends it after 10 min without a client."
								onClick={() => {
									ptyRef.current?.close();
									onDetach();
								}}
							>
								Detach
							</Button>
							<Button
								size="xs"
								variant="outline"
								disabled={closing}
								title="End the shell (SIGTERM, then SIGKILL)"
								onClick={close}
							>
								Close
							</Button>
						</>
					)}
				</div>
			</div>
			<XtermView key={attemptNo} onReady={onReady} className="flex-1" />
			<p className="text-xs text-muted-foreground">
				Copy and paste with the browser (select to copy; Ctrl/⌘+V to paste).
			</p>
		</div>
	);
}

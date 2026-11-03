"use client";
// Output of one command in a read-only xterm (S8 §9.6 Commands):
// `cmd.follow` over NDJSON from the start or the last part, stdout and
// stderr in one window with stderr red (or one of them), `truncated` as a
// line, the exit as a line. One stream at a time; it closes when the
// viewer goes away. Download links of up to 4 MiB from an offset
// (`/output?…&team=`), Kill and Signal for a running command.
import type { CommandData, Sandbox } from "@umiak/sdk";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useAttempt } from "@/lib/client-call";
import { useDescribeError } from "@/lib/use-error";
import {
	defaultDownloadOffset,
	frameText,
	hasLongOutput,
	isRunning,
	type OutputFilter,
	outputDownloadUrl,
	tailOffsets,
} from "./output";
import { type XtermHandle, XtermView } from "./xterm-lazy";

const SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGHUP",
	"SIGUSR1",
	"SIGUSR2",
	"SIGQUIT",
] as const;

export function OutputView({
	teamId,
	handle,
	command: c,
	readable,
	controlOff,
	onChanged,
}: {
	teamId: string;
	handle: Sandbox;
	command: CommandData;
	/** Why Kill and Signal are off (blocked, not ready); null: they work. */
	controlOff: string | null;
	/** The sandbox is ready (output lives in the VM). */
	readable: boolean;
	/** The command ended or was signalled: refresh the list. */
	onChanged: () => void;
}) {
	const attempt = useAttempt();
	const describeError = useDescribeError();
	const [filter, setFilter] = useState<OutputFilter>("all");
	const [from, setFrom] = useState<"start" | "tail">(
		hasLongOutput(c) ? "tail" : "start",
	);
	const [round, setRound] = useState(0);
	const [failed, setFailed] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const pty = c.mode === "pty";
	// The offsets are taken once per viewer round, not on every list refresh.
	const [startAt] = useState(() => tailOffsets(c));

	const onReady = useCallback(
		({ term }: XtermHandle) => {
			const ac = new AbortController();
			setFailed(null);
			void (async () => {
				try {
					const events = handle.command(c.id).follow({
						from: from === "start" ? "start" : startAt,
						signal: ac.signal,
					});
					for await (const ev of events) {
						const text = frameText(ev, filter);
						if (text !== null) term.write(text);
						if (ev.type === "exit") onChanged();
					}
				} catch (e) {
					if (ac.signal.aborted) return;
					const msg = describeError(e).message;
					term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
					setFailed(msg);
				}
			})();
			return () => ac.abort();
		},
		// "Reload" (round) remounts the terminal, which opens a new stream.
		[handle, c.id, from, filter, startAt, onChanged, describeError],
	);

	const signal = async (sig: (typeof SIGNALS)[number]) => {
		setBusy(true);
		const r = await attempt(() => handle.command(c.id).signal(sig));
		setBusy(false);
		if (r !== undefined) {
			toast.success(`${sig} sent`);
			onChanged();
		}
	};
	const kill = async () => {
		setBusy(true);
		const r = await attempt(() => handle.command(c.id).kill());
		setBusy(false);
		if (r !== undefined) {
			toast.success("Killing the command");
			onChanged();
		}
	};

	return (
		<div className="flex flex-col gap-2" data-testid="output-view">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<code className="max-w-md truncate bg-muted px-1.5 py-0.5 text-xs">
					{c.command ?? c.argv?.join(" ") ?? c.id}
				</code>
				{!pty && (
					<NativeSelect
						aria-label="Streams"
						size="xs"
						value={filter}
						onChange={(e) => setFilter(e.target.value as OutputFilter)}
					>
						<option value="all">stdout + stderr</option>
						<option value="stdout">stdout only</option>
						<option value="stderr">stderr only</option>
					</NativeSelect>
				)}
				{hasLongOutput(c) && (
					<NativeSelect
						aria-label="From"
						size="xs"
						value={from}
						onChange={(e) => setFrom(e.target.value as "start" | "tail")}
					>
						<option value="tail">last 1 MiB</option>
						<option value="start">from the start</option>
					</NativeSelect>
				)}
				{failed && (
					<Button
						size="xs"
						variant="outline"
						onClick={() => setRound((n) => n + 1)}
					>
						Reload
					</Button>
				)}
				{isRunning(c.status) && (
					<div className="ml-auto flex items-center gap-1">
						<NativeSelect
							aria-label="Send a signal"
							size="xs"
							value=""
							disabled={busy || controlOff !== null}
							title={controlOff ?? undefined}
							onChange={(e) => {
								const v = e.target.value as (typeof SIGNALS)[number];
								if (v) void signal(v);
							}}
						>
							<option value="">Signal…</option>
							{SIGNALS.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</NativeSelect>
						<Button
							size="xs"
							variant="destructive"
							disabled={busy || controlOff !== null}
							title={controlOff ?? undefined}
							onClick={kill}
						>
							Kill
						</Button>
					</div>
				)}
			</div>
			{readable ? (
				<XtermView
					key={`${c.id}:${filter}:${from}:${round}`}
					readOnly
					convertEol={!pty}
					onReady={onReady}
					className="h-96"
				/>
			) : (
				<p className="text-sm text-muted-foreground">
					The output lives in the VM: resume the sandbox to read it.
				</p>
			)}
			<Downloads teamId={teamId} sandboxId={handle.id} command={c} />
		</div>
	);
}

function Downloads({
	teamId,
	sandboxId,
	command: c,
}: {
	teamId: string;
	sandboxId: string;
	command: CommandData;
}) {
	const streams =
		c.mode === "pty" ? (["pty"] as const) : (["stdout", "stderr"] as const);
	const [stream, setStream] = useState<(typeof streams)[number]>(streams[0]);
	const [offset, setOffset] = useState<string>("");
	const dflt = defaultDownloadOffset(c, stream);
	const at = offset.trim() === "" ? dflt : Number(offset);
	const valid = Number.isInteger(at) && at >= 0;
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span>Download up to 4 MiB of</span>
			<NativeSelect
				aria-label="Stream to download"
				size="xs"
				value={stream}
				onChange={(e) => setStream(e.target.value as (typeof streams)[number])}
			>
				{streams.map((s) => (
					<option key={s} value={s}>
						{s}
					</option>
				))}
			</NativeSelect>
			<span>from byte</span>
			<Input
				aria-label="Offset"
				size="xs"
				className="w-28"
				inputMode="numeric"
				placeholder={String(dflt)}
				value={offset}
				onChange={(e) => setOffset(e.target.value)}
			/>
			{valid ? (
				<a
					className="underline"
					href={outputDownloadUrl({
						sandboxId,
						commandId: c.id,
						stream,
						offset: at,
						teamId,
					})}
					download={`${c.id}.${stream}.log`}
				>
					Download {stream}
				</a>
			) : (
				<span className="text-destructive">not a byte offset</span>
			)}
			<span>(default: the last 4 MiB)</span>
		</div>
	);
}

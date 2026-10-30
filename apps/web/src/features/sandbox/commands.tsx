"use client";
// Commands tab (S8 §9.6): GET /commands (status, command, exit code,
// duration, who, tags) with a status filter; "Run command" → `sb.start()`
// (detached, Idempotency-Key), then its output; the output of a chosen
// command below the table.
import type { CommandData, Sandbox, SandboxData } from "@sbx/sdk";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { PlayIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Field, FormDialog } from "@/components/app/form-dialog";
import { QueryError } from "@/components/app/query-error";
import { useAppSession } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { envKeyProblem } from "@/lib/create-form";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { cn } from "@/lib/utils";
import { formatDuration, isRunning } from "./output";
import { OutputView } from "./output-view";
import { canRead, canWork } from "./rules";

const STATUSES = [
	"running",
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
] as const;
const START_RETRY_BUDGET_MS = 15_000;

export function commandsKey(teamId: string, sandboxId: string) {
	return ["commands", teamId, sandboxId] as const;
}

export function CommandsTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const queryClient = useQueryClient();
	const session = useAppSession();
	const [status, setStatus] = useState<string>("all");
	const [selected, setSelected] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const key = commandsKey(teamId, sandbox.id);
	const list = useInfiniteQuery({
		queryKey: [...key, status],
		queryFn: async ({ pageParam, signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/commands",
				{
					params: {
						path: { sandbox: sandbox.id },
						query: {
							limit: 50,
							...(status === "all" ? {} : { status }),
							...(pageParam === undefined ? {} : { cursor: pageParam }),
						},
					},
					signal,
				},
			);
			return data;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		refetchInterval: (q) =>
			q.state.data?.pages.some((p) => p.data.some((c) => isRunning(c.status)))
				? 5_000
				: false,
		refetchIntervalInBackground: false,
	});
	const rows = useMemo(
		() => (list.data?.pages ?? []).flatMap((p) => p.data),
		[list.data],
	);
	const chosen = rows.find((c) => c.id === selected) ?? null;
	const refresh = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: ["commands", teamId, sandbox.id],
		});
	}, [queryClient, teamId, sandbox.id]);
	const work = canWork(sandbox);
	const now = Date.now();

	const who = (c: CommandData) => {
		if (c.createdBy !== null && c.createdBy === session.user.id) return "you";
		if (c.createdByKey !== null) return "a team key";
		return c.createdBy === null ? "—" : "a teammate";
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<select
					aria-label="Status"
					className="h-8 rounded-lg border bg-transparent px-2 text-sm"
					value={status}
					onChange={(e) => setStatus(e.target.value)}
				>
					<option value="all">status: all</option>
					{STATUSES.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
				<Button
					size="sm"
					className="ml-auto"
					disabled={!work.ok}
					title={work.ok ? undefined : work.reason}
					onClick={() => setRunning(true)}
				>
					<PlayIcon /> Run command
				</Button>
			</div>
			{list.isError && (
				<QueryError
					error={list.error}
					what="commands"
					onRetry={() => list.refetch()}
				/>
			)}
			{list.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{list.data && rows.length === 0 && (
				<p className="text-sm text-muted-foreground">No commands yet.</p>
			)}
			{rows.length > 0 && (
				<Table data-testid="commands-table">
					<TableHeader>
						<TableRow>
							<TableHead>Status</TableHead>
							<TableHead>Command</TableHead>
							<TableHead>Exit</TableHead>
							<TableHead>Duration</TableHead>
							<TableHead>By</TableHead>
							<TableHead>Tags</TableHead>
							<TableHead>Started</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((c) => (
							<TableRow
								key={c.id}
								data-testid="command-row"
								className={cn(
									"cursor-pointer",
									c.id === selected && "bg-muted",
								)}
								onClick={() => setSelected(c.id)}
							>
								<TableCell
									className={cn(
										isRunning(c.status) && "text-emerald-700",
										(c.status === "failed_to_start" || c.status === "lost") &&
											"text-destructive",
									)}
								>
									{c.status}
								</TableCell>
								<TableCell className="max-w-80">
									<button
										type="button"
										className="block w-full truncate text-left font-mono text-xs hover:underline"
									>
										{c.mode === "pty" && (
											<span className="mr-1 text-muted-foreground">[pty]</span>
										)}
										{c.command ?? c.argv?.join(" ") ?? "login shell"}
									</button>
								</TableCell>
								<TableCell>
									{c.exitCode ?? (c.signal ? c.signal : "—")}
								</TableCell>
								<TableCell>
									{formatDuration(c.startedAt, c.endedAt, now)}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{who(c)}
								</TableCell>
								<TableCell>
									<div className="flex flex-wrap gap-1">
										{Object.entries(c.tags).map(([k, v]) => (
											<code key={k} className="rounded bg-muted px-1 text-xs">
												{k}={v}
											</code>
										))}
									</div>
								</TableCell>
								<TableCell className="text-muted-foreground">
									{formatAgo(c.createdAt, now)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{list.hasNextPage && (
				<Button
					variant="outline"
					size="sm"
					disabled={list.isFetchingNextPage}
					onClick={() => list.fetchNextPage()}
				>
					{list.isFetchingNextPage ? "Loading…" : "Load more"}
				</Button>
			)}
			{chosen && (
				<OutputView
					key={chosen.id}
					teamId={teamId}
					handle={handle}
					command={chosen}
					readable={canRead(sandbox).ok}
					onChanged={refresh}
				/>
			)}
			<RunDialog
				handle={handle}
				open={running}
				onOpenChange={setRunning}
				onStarted={(c) => {
					setStatus("all");
					setSelected(c.id);
					queryClient.setQueryData(
						[...key, "all"],
						(old: typeof list.data | undefined) =>
							old === undefined
								? old
								: {
										...old,
										pages: old.pages.map((p, i) =>
											i === 0
												? {
														...p,
														data: [c, ...p.data.filter((x) => x.id !== c.id)],
													}
												: p,
										),
									},
					);
					refresh();
				}}
			/>
		</div>
	);
}

/** `KEY=value` lines → env; null and an error for a bad line. */
function parseEnvLines(text: string): {
	env: Record<string, string>;
	error: string | null;
} {
	const env: Record<string, string> = {};
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const eq = line.indexOf("=");
		const k = eq < 0 ? line : line.slice(0, eq);
		const p = eq < 0 ? "Use KEY=value" : envKeyProblem(k);
		if (p !== null) return { env, error: `Line ${i + 1}: ${p}` };
		env[k] = line.slice(eq + 1);
	}
	return { env, error: null };
}

function RunDialog({
	handle,
	open,
	onOpenChange,
	onStarted,
}: {
	handle: Sandbox;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onStarted: (c: CommandData) => void;
}) {
	const [cmd, setCmd] = useState("");
	const [cwd, setCwd] = useState("");
	const [user, setUser] = useState("");
	const [envText, setEnvText] = useState("");
	const [timeout, setTimeoutText] = useState("");
	const slot = useRef<IdempotencySlot | null>(null);
	const env = parseEnvLines(envText);
	const t = timeout.trim();
	const timeoutSeconds = t === "" ? undefined : Number(t);
	const timeoutError =
		timeoutSeconds !== undefined &&
		(!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
			? "Whole seconds, at least 1"
			: null;
	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Run command"
			description="Runs detached with bash -lc; the output appears below the table."
			submitLabel="Run"
			submitDisabled={
				cmd.trim() === "" || env.error !== null || timeoutError !== null
			}
			onSubmit={async () => {
				const spec = {
					...(cwd.trim() === "" ? {} : { cwd: cwd.trim() }),
					...(user.trim() === "" ? {} : { user: user.trim() }),
					...(Object.keys(env.env).length === 0 ? {} : { env: env.env }),
					...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
				};
				const s = slotFor(slot.current, { cmd, ...spec });
				try {
					const c = await handle.start(cmd, {
						...spec,
						idempotencyKey: s.key,
						retryBudgetMs: START_RETRY_BUDGET_MS,
					});
					slot.current = slotAfter(s, undefined);
					if (c.data) onStarted(c.data);
				} catch (e) {
					slot.current = slotAfter(s, e);
					toast.error(describeError(e).message);
					return false;
				}
				setCmd("");
				setEnvText("");
				return true;
			}}
		>
			<Field label="Command">
				<textarea
					className="min-h-16 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-sm"
					spellCheck={false}
					value={cmd}
					placeholder="npm test"
					onChange={(e) => setCmd(e.target.value)}
				/>
			</Field>
			<div className="grid grid-cols-2 gap-3">
				<Field label="Working directory" hint="Default: the home directory">
					<Input
						value={cwd}
						spellCheck={false}
						onChange={(e) => setCwd(e.target.value)}
					/>
				</Field>
				<Field label="User" hint="Default: user">
					<Input
						value={user}
						spellCheck={false}
						onChange={(e) => setUser(e.target.value)}
					/>
				</Field>
			</div>
			<Field
				label="Environment"
				error={env.error}
				hint="KEY=value per line; not stored"
			>
				<textarea
					className="min-h-14 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs"
					spellCheck={false}
					autoComplete="off"
					value={envText}
					onChange={(e) => setEnvText(e.target.value)}
				/>
			</Field>
			<Field
				label="Timeout (seconds)"
				error={timeoutError}
				hint="Empty: no timeout"
			>
				<Input
					inputMode="numeric"
					value={timeout}
					onChange={(e) => setTimeoutText(e.target.value)}
				/>
			</Field>
		</FormDialog>
	);
}

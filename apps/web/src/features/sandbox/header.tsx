"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// Header of the sandbox page (S8 §9.6): name, slug with rename, state,
// health, activity, template, size, origin, labels, TTL, idle timeout; the
// actions Stop/Resume/Fork/Recover/Extend/Save snapshot/Delete; the bar of
// the active operation and the error block. A blocked sandbox shows the
// lock and its reason; forbidden actions are disabled (S8 §17.1 C3). Fork
// and Save snapshot of a running Windows sandbox ask before they stop and
// restart it (S9 §24.8).
import type { SandboxData } from "@umiak/sdk";
import {
	ArchiveIcon,
	ChevronLeftIcon,
	ClockPlusIcon,
	GitForkIcon,
	LoaderCircleIcon,
	LockIcon,
	MonitorIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	RotateCcwIcon,
	TerminalIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { CopyButton } from "@/components/app/copy-button";
import { Field, FormDialog } from "@/components/app/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUmiak } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { copyText } from "@/lib/clipboard";
import { slugProblem } from "@/lib/create-form";
import { describeError, isSnapshotRequiresStop } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { teamPath } from "@/lib/team-path";
import { DeleteSandboxDialog } from "../sandboxes/delete-dialog";
import { useNeedsForceStop } from "../sandboxes/force-stop";
import { sandboxHref } from "../sandboxes/links";
import { useRefreshSandboxes } from "../sandboxes/row-actions";
import {
	BlockLock,
	blockText,
	HealthCell,
	StateCell,
} from "../sandboxes/state-cell";
import { useFork } from "../sandboxes/use-fork";
import {
	FORCE_STOP_TEXT,
	formatSeconds,
	headerActions,
	SNAPSHOT_NAME_RE,
} from "./rules";
import { sandboxQueryKey } from "./use-sandbox";

export function SandboxHeader({
	teamId,
	sandbox: s,
	desktop = false,
	track,
}: {
	teamId: string;
	sandbox: SandboxData;
	desktop?: boolean;
	track: (operationId: string) => void;
}) {
	const umiak = useUmiak(teamId);
	const router = useRouter();
	const refreshAll = useRefreshSandboxes(teamId);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<
		null | "rename" | "extend" | "snapshot" | "delete"
	>(null);
	const a = headerActions(s);
	const path = { params: { path: { sandbox: s.id } } };
	const forking = useFork(teamId, s, refreshAll);

	/** An action that answers {sandbox, operation}: the loop awaits the operation. */
	const act = async (
		label: string,
		fn: () => Promise<{ data: { operation: { id: string } } }>,
	) => {
		setBusy(true);
		const r = await attempt(fn);
		setBusy(false);
		if (r === undefined) return false;
		track(r.data.operation.id);
		toast.success(label);
		await attempt(refreshAll);
		return true;
	};

	return (
		<header className="sandbox-header space-y-2">
			<Link
				href={teamPath(teamId)}
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
			>
				<ChevronLeftIcon className="size-4" /> Sandboxes
			</Link>
			<div className="space-y-2">
				<div className="sandbox-title">
					<h1 className="sandbox-detail-heading flex items-center gap-2 font-semibold">
						<span className="truncate">{s.name ?? s.slug}</span>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label="Rename slug"
							title="Rename slug"
							disabled={!a.rename}
							onClick={() => setDialog("rename")}
						>
							<PencilIcon />
						</Button>
						<BlockLock sandbox={s} />
					</h1>
					<div className="flex items-center gap-1 text-sm text-muted-foreground">
						<code data-testid="sandbox-slug">{s.slug}</code>

						<code className="ml-3 text-xs">{s.id}</code>
						<CopyButton text={s.id} label="Copy sandbox ID" />
					</div>
				</div>
				<div className="sandbox-actions">
					<Button
						variant="ghost"
						disabled={s.state !== "ready" || s.blocked}
						onClick={() =>
							void attempt(async () => {
								await copyText(s.endpoints.ssh);
								toast.success("SSH command copied");
							})
						}
					>
						<TerminalIcon />
						Copy SSH
					</Button>
					{desktop && (
						<Button
							variant="ghost"
							disabled={s.state !== "ready" || s.blocked}
							onClick={() =>
								router.replace(sandboxHref(teamId, s.slug, "desktop"))
							}
						>
							<MonitorIcon />
							Desktop
						</Button>
					)}
					{s.state === "stopped" ? (
						<Button
							size="default"
							variant="ghost"
							disabled={busy || !a.resume}
							onClick={() =>
								act(`Resuming ${s.slug}`, () =>
									umiak.raw.POST("/v1/sandboxes/{sandbox}/resume", {
										...path,
										body: {},
									}),
								)
							}
						>
							<PlayIcon />
							Resume
						</Button>
					) : (
						<Button
							size="default"
							variant="ghost"
							disabled={busy || !a.stop}
							onClick={() =>
								act(`Stopping ${s.slug}`, () =>
									umiak.raw.POST("/v1/sandboxes/{sandbox}/stop", path),
								)
							}
						>
							<PauseIcon />
							Stop
						</Button>
					)}
					<Button
						size="default"
						variant="ghost"
						disabled={busy || !a.fork}
						onClick={async () => {
							setBusy(true);
							try {
								await forking.fork();
							} finally {
								setBusy(false);
							}
						}}
					>
						<GitForkIcon />
						Fork
					</Button>
					<ConfirmButton
						size="default"
						variant="ghost"
						title={`Recover ${s.slug}?`}
						description="Recover restarts the VM (a power cycle): running commands and terminals end, files on disk stay."
						confirmLabel="Recover"
						disabled={busy || !a.recover}
						onConfirm={() =>
							act(`Recovering ${s.slug}`, () =>
								umiak.raw.POST("/v1/sandboxes/{sandbox}/recover", path),
							)
						}
					>
						<RotateCcwIcon />
						Recover
					</ConfirmButton>
					<Button
						size="default"
						variant="ghost"
						disabled={busy || !a.extend}
						title={
							s.ttlSeconds === null && s.deadlineAt === null
								? "The sandbox has no TTL"
								: undefined
						}
						onClick={() => setDialog("extend")}
					>
						<ClockPlusIcon />
						Extend
					</Button>
					<Button
						size="default"
						variant="ghost"
						disabled={busy || !a.saveSnapshot}
						onClick={() => setDialog("snapshot")}
					>
						<ArchiveIcon />
						Save snapshot
					</Button>
					<Button
						size="default"
						variant="destructive"
						className="basis-full justify-start"
						disabled={busy || !a.delete}
						onClick={() => setDialog("delete")}
					>
						<TrashIcon />
						Delete
					</Button>
				</div>
			</div>
			<Facts teamId={teamId} sandbox={s} />
			{s.blocked && (
				<div
					role="status"
					className="flex items-center gap-2 rounded-lg border border-warning/35 bg-warning-tint p-3 text-sm text-warning"
				>
					<LockIcon className="size-4 shrink-0" />
					<p>
						{blockText(s)}. Its ports and SSH are refused; only reading, stop
						and delete work.
					</p>
				</div>
			)}
			<OperationBar sandbox={s} />
			<ErrorBlock
				sandbox={s}
				busy={busy}
				onRecover={() =>
					act(`Recovering ${s.slug}`, () =>
						umiak.raw.POST("/v1/sandboxes/{sandbox}/recover", path),
					)
				}
			/>
			<RenameDialog
				teamId={teamId}
				sandbox={s}
				open={dialog === "rename"}
				onOpenChange={(o) => setDialog(o ? "rename" : null)}
			/>
			<ExtendDialog
				teamId={teamId}
				sandbox={s}
				open={dialog === "extend"}
				onOpenChange={(o) => setDialog(o ? "extend" : null)}
			/>
			{forking.dialog}
			<SnapshotDialog
				teamId={teamId}
				sandbox={s}
				track={track}
				open={dialog === "snapshot"}
				onOpenChange={(o) => setDialog(o ? "snapshot" : null)}
			/>
			<DeleteSandboxDialog
				teamId={teamId}
				sandbox={s}
				open={dialog === "delete"}
				onOpenChange={(o) => setDialog(o ? "delete" : null)}
				onDeleted={async () => {
					toast.success(`Deleting ${s.slug}`);
					await attempt(refreshAll);
					router.push(teamPath(teamId));
				}}
			/>
		</header>
	);
}

function originText(teamId: string, s: SandboxData) {
	const o = s.origin;
	if (o.kind === "snapshot") {
		return (
			<>
				snapshot{" "}
				{o.snapshot ? (
					<Link className="underline" href={teamPath(teamId, "snapshots")}>
						{o.snapshot}
					</Link>
				) : (
					"(deleted)"
				)}
			</>
		);
	}
	if (o.kind === "fork" && o.sandboxId) {
		return (
			<>
				fork of{" "}
				<Link className="underline" href={sandboxHref(teamId, o.sandboxId)}>
					{o.sandboxId}
				</Link>
			</>
		);
	}
	return o.kind;
}

function Facts({
	teamId,
	sandbox: s,
}: {
	teamId: string;
	sandbox: SandboxData;
}) {
	const labels = Object.entries(s.labels);
	return (
		<dl className="sandbox-facts">
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">State</dt>
				<dd>
					<StateCell sandbox={s} />
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Health</dt>
				<dd>
					<HealthCell sandbox={s} />
					<span className="ml-2 text-muted-foreground">
						activity: {s.activity}
					</span>
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Template</dt>
				<dd>
					{s.template}
					{s.templateVersion ? ` · ${s.templateVersion}` : ""}
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Size</dt>
				<dd>
					{s.size} · {s.vcpu} vCPU · {s.memoryMb} MB
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Origin</dt>
				<dd>{originText(teamId, s)}</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Labels</dt>
				<dd className="flex flex-wrap gap-1">
					{labels.length === 0
						? "—"
						: labels.map(([k, v]) => (
								<code key={k} className="rounded bg-muted px-1 text-xs">
									{k}={v}
								</code>
							))}
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">TTL</dt>
				<dd>
					{formatSeconds(s.ttlSeconds)}
					{s.deadlineAt && (
						<span className="text-muted-foreground">
							{" "}
							· deleted at {formatTime(s.deadlineAt)}
						</span>
					)}
				</dd>
			</div>
			<div className="sandbox-fact">
				<dt className="text-muted-foreground">Idle stop</dt>
				<dd>
					{s.idleTimeoutSeconds === null
						? "off"
						: `after ${formatSeconds(s.idleTimeoutSeconds)}`}
				</dd>
			</div>
		</dl>
	);
}

function OperationBar({ sandbox: s }: { sandbox: SandboxData }) {
	const op = s.activeOperation;
	if (op === null) return null;
	return (
		<div
			role="status"
			data-testid="operation-bar"
			className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm"
		>
			<LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
			<span className="font-medium">{op.kind.replace("_", " ")}</span>
			<span className="text-muted-foreground">
				{op.state}
				{op.step ? ` · ${op.step}` : ""}
			</span>
			<div className="ml-2 h-1 flex-1 overflow-hidden rounded bg-muted">
				<div className="h-full w-1/3 animate-pulse rounded bg-primary/60" />
			</div>
		</div>
	);
}

function ErrorBlock({
	sandbox: s,
	busy,
	onRecover,
}: {
	sandbox: SandboxData;
	busy: boolean;
	onRecover: () => void;
}) {
	if (s.state !== "error") return null;
	return (
		<div
			role="alert"
			data-testid="sandbox-error"
			className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
		>
			<div className="flex-1">
				<p className="font-medium text-destructive">
					{s.error?.code ?? "error"}
				</p>
				<p>{s.error?.message ?? "The sandbox failed."}</p>
			</div>
			{headerActions(s).recover && (
				<Button size="sm" variant="outline" disabled={busy} onClick={onRecover}>
					Recover
				</Button>
			)}
		</div>
	);
}

function RenameDialog({
	teamId,
	sandbox: s,
	open,
	onOpenChange,
}: {
	teamId: string;
	sandbox: SandboxData;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const umiak = useUmiak(teamId);
	const router = useRouter();
	const params = useSearchParams();
	const queryClient = useQueryClient();
	const [slug, setSlug] = useState(s.slug);
	const problem = slug === s.slug ? null : slugProblem(slug.trim());
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => {
				if (o) setSlug(s.slug);
				onOpenChange(o);
			}}
			title="Rename slug"
			description="The slug is the name in port URLs, SSH and the guest hostname. Published port URLs and their cookies change at once."
			submitLabel="Rename"
			submitDisabled={problem !== null || slug.trim() === s.slug}
			onSubmit={async () => {
				const r = await attempt(() =>
					umiak.raw.PATCH("/v1/sandboxes/{sandbox}", {
						params: { path: { sandbox: s.id } },
						body: { slug: slug.trim() },
					}),
				);
				if (r === undefined) return false;
				toast.success(`Renamed to ${r.data.slug}`);
				// The page's query is keyed by the old slug: seed the new one and
				// refresh only the lists (a refetch by the old slug would be a 404).
				queryClient.setQueryData(sandboxQueryKey(teamId, r.data.slug), r.data);
				await queryClient.invalidateQueries({
					queryKey: ["sandboxes", teamId],
					predicate: (q) => q.queryKey[2] !== "one",
				});
				const tab = params.get("tab");
				router.replace(
					sandboxHref(teamId, r.data.slug, (tab ?? undefined) as never),
				);
				return true;
			}}
		>
			<Field label="Slug" error={problem}>
				<Input
					value={slug}
					autoComplete="off"
					spellCheck={false}
					aria-invalid={problem !== null}
					onChange={(e) => setSlug(e.target.value)}
				/>
			</Field>
		</FormDialog>
	);
}

const EXTEND_CHOICES: { label: string; seconds: number | null }[] = [
	{ label: "The sandbox's TTL", seconds: null },
	{ label: "1 hour", seconds: 3600 },
	{ label: "4 hours", seconds: 4 * 3600 },
	{ label: "1 day", seconds: 86_400 },
	{ label: "7 days", seconds: 7 * 86_400 },
];

function ExtendDialog({
	teamId,
	sandbox: s,
	open,
	onOpenChange,
}: {
	teamId: string;
	sandbox: SandboxData;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const umiak = useUmiak(teamId);
	const queryClient = useQueryClient();
	const [choice, setChoice] = useState(0);
	const seconds = EXTEND_CHOICES[choice]?.seconds ?? null;
	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Extend ${s.slug}`}
			description={`The new deadline is now + the chosen time. Now: ${formatTime(s.deadlineAt)}.`}
			submitLabel="Extend"
			onSubmit={async () => {
				const r = await attempt(() =>
					umiak.raw.POST("/v1/sandboxes/{sandbox}/extend", {
						params: { path: { sandbox: s.id } },
						body: seconds === null ? {} : { ttlSeconds: seconds },
					}),
				);
				if (r === undefined) return false;
				toast.success(`Deleted at ${formatTime(r.data.deadlineAt)} now`);
				await queryClient.invalidateQueries({
					queryKey: ["sandboxes", teamId],
				});
				return true;
			}}
		>
			<Field label="Extend by">
				<select
					className="h-8 rounded-lg border bg-transparent px-2 text-sm"
					value={choice}
					onChange={(e) => setChoice(Number(e.target.value))}
				>
					{EXTEND_CHOICES.map((c, i) => (
						<option
							key={c.label}
							value={i}
							disabled={c.seconds === null && s.ttlSeconds === null}
						>
							{c.label}
							{c.seconds === null && s.ttlSeconds !== null
								? ` (${formatSeconds(s.ttlSeconds)})`
								: ""}
						</option>
					))}
				</select>
			</Field>
		</FormDialog>
	);
}

function SnapshotDialog({
	teamId,
	sandbox: s,
	track,
	open,
	onOpenChange,
}: {
	teamId: string;
	sandbox: SandboxData;
	track: (op: string) => void;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const umiak = useUmiak(teamId);
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const key = useRef<IdempotencySlot | null>(null);
	// A running Windows sandbox is saved with forceStop (S9 §24.8): known from
	// the catalog, or learnt from the API's 409; the dialog says what happens.
	const windows = useNeedsForceStop(teamId, s);
	const [requiresStop, setRequiresStop] = useState(false);
	const forceStop = windows || requiresStop;
	const snapshots = useQuery({
		queryKey: ["snapshots", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await umiak.raw.GET("/v1/snapshots", { signal });
			return data.data;
		},
		enabled: open,
	});
	const n = name.trim();
	const problem =
		n === "" || SNAPSHOT_NAME_RE.test(n)
			? null
			: "Lowercase letters, digits and '-', starting with a letter or digit, up to 63 characters";
	const replaces = (snapshots.data ?? []).some(
		(x) => x.name === n && x.state === "ready",
	);
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => {
				if (!o) setRequiresStop(false);
				onOpenChange(o);
			}}
			title={`Save a snapshot of ${s.slug}`}
			description="A saved snapshot keeps the disk; new sandboxes can start from it."
			submitLabel={
				forceStop
					? replaces
						? "Stop and replace snapshot"
						: "Stop and save snapshot"
					: replaces
						? "Replace snapshot"
						: "Save snapshot"
			}
			destructive={replaces || forceStop}
			submitDisabled={n === "" || problem !== null}
			onSubmit={async () => {
				const body = {
					sandbox: s.id,
					name: n,
					...(forceStop ? { forceStop: true } : {}),
				};
				const slot = slotFor(key.current, body);
				try {
					const { data } = await umiak.raw.POST("/v1/snapshots", {
						body,
						idempotencyKey: slot.key,
					});
					key.current = slotAfter(slot, undefined);
					track(data.operation.id);
				} catch (e) {
					key.current = slotAfter(slot, e);
					if (!forceStop && isSnapshotRequiresStop(e)) {
						// Ask: the next submit sends forceStop.
						setRequiresStop(true);
						return false;
					}
					toast.error(describeError(e).message);
					return false;
				}
				setRequiresStop(false);
				toast.success(`Saving snapshot ${n}`);
				setName("");
				await attempt(() =>
					queryClient.invalidateQueries({ queryKey: ["snapshots", teamId] }),
				);
				return true;
			}}
		>
			<Field
				label="Name"
				error={problem}
				hint="Unique in the team, e.g. web-stack"
			>
				<Input
					value={name}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setName(e.target.value)}
				/>
			</Field>
			{replaces && (
				<p className="text-sm text-warning">
					A snapshot named {n} exists: it is replaced when the new one is ready.
				</p>
			)}
			{forceStop && (
				<p role="alert" className="text-sm text-warning">
					{requiresStop
						? "This Windows sandbox is snapshotted only from a stopped VM. "
						: ""}
					{FORCE_STOP_TEXT}
				</p>
			)}
		</FormDialog>
	);
}

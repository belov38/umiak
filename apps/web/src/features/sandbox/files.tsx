"use client";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
// Files tab (S8 §9.6): GET /files/list with pages, breadcrumbs, hidden
// files, a text preview of up to 1 MiB in <pre> (never HTML or an iframe),
// download through a link with `?team=`, upload by button or drag and drop
// (≤ 64 MiB one PUT, larger in resumable chunks with progress), mkdir,
// move/rename, delete (recursive with a confirmation).
import type { FileInfo, Sandbox, SandboxData } from "@umiak/sdk";
import {
	FileIcon,
	FolderIcon,
	LinkIcon,
	RefreshCwIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { Field, FormDialog } from "@/components/app/form-dialog";
import { QueryError } from "@/components/app/query-error";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
	breadcrumbs,
	decodePreview,
	fileDownloadUrl,
	joinPath,
	PREVIEW_MAX_BYTES,
	parentPath,
	previewable,
	uploadStrategy,
} from "./files-path";
import { canRead, canWork, formatBytes, modeString } from "./rules";

const PAGE = 200;
const UPLOAD_RETRY_BUDGET_MS = 60_000;

interface UploadItem {
	key: number;
	name: string;
	size: number;
	sent: number;
	state: "uploading" | "done" | "failed" | "cancelled";
	error?: string;
	ac: AbortController;
}

export function FilesTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const queryClient = useQueryClient();
	const read = canRead(sandbox);
	const work = canWork(sandbox);
	const [dir, setDir] = useState<string | null>(null);
	const [hidden, setHidden] = useState(false);
	const [preview, setPreview] = useState<FileInfo | null>(null);
	const [moving, setMoving] = useState<FileInfo | null>(null);
	const [mkdir, setMkdir] = useState(false);
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	const [dragging, setDragging] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const counter = useRef(0);
	// Aborted when the tab unmounts: uploads in flight stop with it.
	const life = useRef<AbortController | null>(null);
	useEffect(() => {
		const ac = new AbortController();
		life.current = ac;
		return () => ac.abort();
	}, []);

	const home = useQuery({
		queryKey: ["files-home", teamId, sandbox.id],
		queryFn: ({ signal }) => handle.files.stat("~", { signal }),
		enabled: read.ok && dir === null,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const cwd = dir ?? home.data?.path ?? null;
	const listKey = ["files", teamId, sandbox.id, cwd, hidden] as const;
	const list = useInfiniteQuery({
		queryKey: listKey,
		queryFn: async ({ pageParam, signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/files/list",
				{
					params: {
						path: { sandbox: sandbox.id },
						query: {
							path: cwd as string,
							includeHidden: hidden ? "true" : "false",
							limit: PAGE,
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
		enabled: read.ok && cwd !== null,
	});
	const rows = useMemo(() => {
		const all = (list.data?.pages ?? []).flatMap((p) => p.data);
		return all.sort((a, b) =>
			a.type === "dir" && b.type !== "dir"
				? -1
				: b.type === "dir" && a.type !== "dir"
					? 1
					: a.name.localeCompare(b.name),
		);
	}, [list.data]);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["files", teamId, sandbox.id] });

	if (!read.ok)
		return <p className="text-sm text-muted-foreground">{read.reason}</p>;
	if (home.isError && dir === null) {
		return (
			<QueryError
				error={home.error}
				what="the home directory"
				onRetry={() => home.refetch()}
			/>
		);
	}
	if (cwd === null)
		return <p className="text-sm text-muted-foreground">Loading…</p>;

	const upload = async (files: File[]) => {
		const lifetime = life.current?.signal;
		for (const file of files) {
			if (lifetime?.aborted) return;
			const path = joinPath(cwd, file.name);
			if (
				rows.some((r) => r.name === file.name) &&
				!window.confirm(`${file.name} exists in ${cwd}. Replace it?`)
			) {
				continue;
			}
			const item: UploadItem = {
				key: ++counter.current,
				name: file.name,
				size: file.size,
				sent: 0,
				state: "uploading",
				ac: new AbortController(),
			};
			const stop = () => item.ac.abort();
			lifetime?.addEventListener("abort", stop, { once: true });
			const update = (p: Partial<UploadItem>) =>
				setUploads((cur) =>
					cur.map((u) => (u.key === item.key ? { ...u, ...p } : u)),
				);
			setUploads((cur) => [
				...cur.filter((u) => u.state === "uploading"),
				item,
			]);
			try {
				const opts = {
					signal: item.ac.signal,
					retryBudgetMs: UPLOAD_RETRY_BUDGET_MS,
					overwrite: true,
				};
				if (uploadStrategy(file.size) === "put") {
					const bytes = new Uint8Array(await file.arrayBuffer());
					await handle.files.writeBytes(path, bytes, opts);
				} else {
					await handle.files.upload(path, file, {
						...opts,
						onProgress: (sent) => update({ sent }),
					});
				}
				update({ state: "done", sent: file.size });
			} catch (e) {
				if (item.ac.signal.aborted) update({ state: "cancelled" });
				else update({ state: "failed", error: describeError(e).message });
			} finally {
				lifetime?.removeEventListener("abort", stop);
			}
			if (lifetime?.aborted) return;
			await refresh();
		}
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		if (!work.ok) {
			toast.error(work.reason);
			return;
		}
		const items = Array.from(e.dataTransfer.items);
		const dirs = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
		if (dirs.length > 0) {
			toast.info(
				"Folders are not uploaded from the browser: use `umiak push` or `umiak cp -r` from the CLI.",
			);
		}
		const files = items
			.filter((i) => i.kind === "file" && !i.webkitGetAsEntry?.()?.isDirectory)
			.map((i) => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length > 0) void upload(files);
	};

	return (
		<section
			aria-label="Files; drop files here to upload them"
			className={cn(
				"space-y-3 rounded-lg",
				dragging && "outline-2 outline-dashed outline-primary",
			)}
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			<div className="flex flex-wrap items-center gap-2">
				<nav
					aria-label="Path"
					className="flex flex-wrap items-center gap-0.5 font-mono text-sm"
					data-testid="breadcrumbs"
				>
					{breadcrumbs(cwd).map((c, i) => (
						<span key={c.path} className="flex items-center">
							{i > 1 && <span className="text-muted-foreground">/</span>}
							<button
								type="button"
								className="rounded px-0.5 hover:underline"
								onClick={() => setDir(c.path)}
							>
								{c.name}
							</button>
						</span>
					))}
				</nav>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<label className="flex items-center gap-1 text-sm">
						<input
							type="checkbox"
							checked={hidden}
							onChange={(e) => setHidden(e.target.checked)}
						/>
						Hidden files
					</label>
					<input
						ref={picker}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							const files = Array.from(e.target.files ?? []);
							e.target.value = "";
							if (files.length > 0) void upload(files);
						}}
					/>
					<Button
						size="sm"
						variant="outline"
						disabled={!work.ok}
						title={work.ok ? "Or drop files here" : work.reason}
						onClick={() => picker.current?.click()}
					>
						<UploadIcon /> Upload
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!work.ok}
						onClick={() => setMkdir(true)}
					>
						<FolderIcon /> New folder
					</Button>
					<Button size="sm" variant="outline" onClick={() => void refresh()}>
						<RefreshCwIcon /> Refresh
					</Button>
				</div>
			</div>
			<Uploads
				items={uploads}
				onDismiss={(k) => setUploads((cur) => cur.filter((u) => u.key !== k))}
			/>
			{list.isError && (
				<QueryError
					error={list.error}
					what="the directory"
					onRetry={() => list.refetch()}
				/>
			)}
			<Table data-testid="files-table">
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Size</TableHead>
						<TableHead>Modified</TableHead>
						<TableHead>Mode</TableHead>
						<TableHead>Owner</TableHead>
						<TableHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{cwd !== "/" && (
						<TableRow>
							<TableCell colSpan={6}>
								<button
									type="button"
									className="font-mono hover:underline"
									onClick={() => setDir(parentPath(cwd))}
								>
									..
								</button>
							</TableCell>
						</TableRow>
					)}
					{rows.map((f) => (
						<TableRow key={f.path} data-testid="file-row">
							<TableCell>
								<button
									type="button"
									className="flex items-center gap-1.5 font-mono text-sm hover:underline"
									onClick={() => {
										if (f.type === "dir") setDir(f.path);
										else if (previewable(f)) setPreview(f);
										else
											toast.info(
												`${f.name} is too large to show (over 1 MiB): download it.`,
											);
									}}
								>
									{f.type === "dir" ? (
										<FolderIcon className="size-4 text-sky-700" />
									) : f.type === "symlink" ? (
										<LinkIcon className="size-4 text-muted-foreground" />
									) : (
										<FileIcon className="size-4 text-muted-foreground" />
									)}
									{f.name}
									{f.type === "dir" && "/"}
									{f.symlinkTarget && (
										<span className="text-xs text-muted-foreground">
											→ {f.symlinkTarget}
										</span>
									)}
								</button>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{f.type === "dir" ? "—" : formatBytes(f.sizeBytes)}
							</TableCell>
							<TableCell className="text-muted-foreground">
								{formatTime(f.modifiedAt)}
							</TableCell>
							<TableCell className="font-mono text-xs text-muted-foreground">
								{modeString(f.type, f.mode)}
							</TableCell>
							<TableCell className="text-muted-foreground">{f.owner}</TableCell>
							<TableCell>
								<div className="flex justify-end gap-1">
									{f.type !== "dir" && (
										<Button asChild size="xs" variant="ghost">
											<a
												href={fileDownloadUrl({
													sandboxId: sandbox.id,
													path: f.path,
													teamId,
												})}
												download={f.name}
											>
												Download
											</a>
										</Button>
									)}
									<Button
										size="xs"
										variant="ghost"
										disabled={!work.ok}
										onClick={() => setMoving(f)}
									>
										Rename
									</Button>
									<ConfirmButton
										size="xs"
										variant="ghost"
										title={`Delete ${f.name}?`}
										description={
											f.type === "dir"
												? `${f.path} and everything in it are deleted. This cannot be undone.`
												: `${f.path} is deleted. This cannot be undone.`
										}
										confirmLabel="Delete"
										disabled={!work.ok}
										onConfirm={async () => {
											const r = await attempt(() =>
												handle.files.remove(f.path, {
													recursive: f.type === "dir",
												}),
											);
											await refresh();
											return r !== undefined;
										}}
									>
										Delete
									</ConfirmButton>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{list.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{list.data && rows.length === 0 && (
				<p className="text-sm text-muted-foreground">
					Empty{hidden ? "" : " (hidden files are not shown)"}. Drop files here
					to upload them.
				</p>
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
			<PreviewDialog
				teamId={teamId}
				handle={handle}
				file={preview}
				onClose={() => setPreview(null)}
			/>
			<MoveDialog
				handle={handle}
				file={moving}
				onClose={() => setMoving(null)}
				onDone={refresh}
			/>
			<MkdirDialog
				handle={handle}
				dir={cwd}
				open={mkdir}
				onOpenChange={setMkdir}
				onDone={refresh}
			/>
		</section>
	);
}

function Uploads({
	items,
	onDismiss,
}: {
	items: UploadItem[];
	onDismiss: (key: number) => void;
}) {
	if (items.length === 0) return null;
	return (
		<ul
			className="space-y-1 rounded-lg border p-2 text-sm"
			data-testid="uploads"
		>
			{items.map((u) => (
				<li key={u.key} className="flex items-center gap-2">
					<span className="w-48 truncate font-mono text-xs">{u.name}</span>
					{u.state === "uploading" ? (
						<>
							<div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
								<div
									className="h-full rounded bg-primary transition-all"
									style={{
										width: `${u.size === 0 ? 0 : Math.round((u.sent / u.size) * 100)}%`,
									}}
								/>
							</div>
							<span className="w-32 text-right text-xs text-muted-foreground">
								{uploadStrategy(u.size) === "chunked"
									? `${formatBytes(u.sent)} of ${formatBytes(u.size)}`
									: formatBytes(u.size)}
							</span>
							<Button size="xs" variant="ghost" onClick={() => u.ac.abort()}>
								Cancel
							</Button>
						</>
					) : (
						<>
							<span
								className={cn(
									"flex-1 text-xs",
									u.state === "done"
										? "text-emerald-700"
										: u.state === "failed"
											? "text-destructive"
											: "text-muted-foreground",
								)}
							>
								{u.state === "failed" ? `failed: ${u.error}` : u.state}
							</span>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label="Dismiss"
								onClick={() => onDismiss(u.key)}
							>
								<XIcon />
							</Button>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

function PreviewDialog({
	teamId,
	handle,
	file,
	onClose,
}: {
	teamId: string;
	handle: Sandbox;
	file: FileInfo | null;
	onClose: () => void;
}) {
	const q = useQuery({
		queryKey: ["file-preview", teamId, handle.id, file?.path, file?.modifiedAt],
		queryFn: async ({ signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/files/content",
				{
					params: {
						path: { sandbox: handle.id },
						query: { path: (file as FileInfo).path },
					},
					headers: { Range: `bytes=0-${PREVIEW_MAX_BYTES - 1}` },
					parseAs: "arrayBuffer",
					signal,
				},
			);
			return decodePreview(
				new Uint8Array((data as ArrayBuffer | undefined) ?? new ArrayBuffer(0)),
			);
		},
		enabled: file !== null,
		staleTime: 0,
		gcTime: 0,
	});
	return (
		<Dialog open={file !== null} onOpenChange={(o) => !o && onClose()}>
			{file && (
				<DialogContent className="sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle className="font-mono text-sm">{file.path}</DialogTitle>
						<DialogDescription>
							{formatBytes(file.sizeBytes)} ·{" "}
							<a
								className="underline"
								href={fileDownloadUrl({
									sandboxId: handle.id,
									path: file.path,
									teamId,
								})}
								download={file.name}
							>
								Download
							</a>
						</DialogDescription>
					</DialogHeader>
					{q.isPending && (
						<p className="text-sm text-muted-foreground">Loading…</p>
					)}
					{q.isError && (
						<p className="text-sm text-destructive">
							{describeError(q.error).message}
						</p>
					)}
					{q.data === null && (
						<p className="text-sm text-muted-foreground">
							This looks like a binary file: download it instead.
						</p>
					)}
					{typeof q.data === "string" && (
						<pre
							data-testid="file-preview"
							className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre"
						>
							{q.data}
						</pre>
					)}
				</DialogContent>
			)}
		</Dialog>
	);
}

function MoveDialog({
	handle,
	file,
	onClose,
	onDone,
}: {
	handle: Sandbox;
	file: FileInfo | null;
	onClose: () => void;
	onDone: () => Promise<unknown>;
}) {
	const [to, setTo] = useState("");
	return (
		<FormDialog
			open={file !== null}
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
			title={`Move or rename ${file?.name ?? ""}`}
			description="A new name in the same folder, or a full path."
			submitLabel="Move"
			submitDisabled={to.trim() === "" || to.trim() === file?.path}
			onSubmit={async () => {
				if (file === null) return true;
				const target = to.trim().startsWith("/")
					? to.trim()
					: joinPath(parentPath(file.path), to.trim());
				const r = await attempt(() => handle.files.move(file.path, target));
				await onDone();
				if (r !== undefined) setTo("");
				return r !== undefined;
			}}
		>
			<Field label="New name or path">
				<Input
					autoFocus
					spellCheck={false}
					placeholder={file?.name}
					value={to}
					onChange={(e) => setTo(e.target.value)}
				/>
			</Field>
		</FormDialog>
	);
}

function MkdirDialog({
	handle,
	dir,
	open,
	onOpenChange,
	onDone,
}: {
	handle: Sandbox;
	dir: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onDone: () => Promise<unknown>;
}) {
	const [name, setName] = useState("");
	const bad = name.includes("/") ? "A name, without /" : null;
	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title="New folder"
			description={`In ${dir}`}
			submitLabel="Create"
			submitDisabled={name.trim() === "" || bad !== null}
			onSubmit={async () => {
				const r = await attempt(() =>
					handle.files.mkdir(joinPath(dir, name.trim())),
				);
				await onDone();
				if (r !== undefined) setName("");
				return r !== undefined;
			}}
		>
			<Field label="Name" error={bad}>
				<Input
					autoFocus
					spellCheck={false}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</Field>
		</FormDialog>
	);
}

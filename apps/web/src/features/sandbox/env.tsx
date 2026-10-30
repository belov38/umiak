"use client";
// Env tab (S8 §9.6): GET /env — env with values, names of secrets (values
// are never sent: "•••"), secret files (name, mode, path). Each change is
// one key through `PATCH /env` (merge, S8 C2): set or delete one secret
// without knowing the others. `delivered: false` → "applies at the next
// start". Secret values live only in the dialog's input until it closes.
import type { components, Sandbox, SandboxData } from "@sbx/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { Field, FormDialog } from "@/components/app/form-dialog";
import { QueryError } from "@/components/app/query-error";
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
import { attempt } from "@/lib/client-call";
import {
	bytesToBase64,
	envKeyProblem,
	LIMITS,
	parseSecretFileMode,
	secretFileName,
	secretFileNameProblem,
} from "@/lib/create-form";
import { canConfigure, formatBytes } from "./rules";

type EnvPatch = components["schemas"]["EnvPatchRequest"];
type EnvEdit =
	| { kind: "env"; key: string | null; value: string }
	| { kind: "secret"; key: string | null };

export function EnvTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const queryClient = useQueryClient();
	const key = ["env", teamId, sandbox.id] as const;
	const q = useQuery({
		queryKey: key,
		queryFn: async ({ signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/env",
				{
					params: { path: { sandbox: sandbox.id } },
					signal,
				},
			);
			return data;
		},
	});
	const [edit, setEdit] = useState<EnvEdit | null>(null);
	const [addFile, setAddFile] = useState(false);
	const [undelivered, setUndelivered] = useState(false);
	const gate = canConfigure(sandbox);

	const patch = async (body: EnvPatch, done: string): Promise<boolean> => {
		const r = await attempt(() =>
			handle.core.raw.PATCH("/v1/sandboxes/{sandbox}/env", {
				params: { path: { sandbox: sandbox.id } },
				body,
			}),
		);
		if (r === undefined) return false;
		const { delivered, ...env } = r.data;
		queryClient.setQueryData(key, env);
		setUndelivered(!delivered);
		toast.success(done);
		return true;
	};

	if (q.isError)
		return (
			<QueryError error={q.error} what="env" onRetry={() => q.refetch()} />
		);
	if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	const env = Object.entries(q.data.env).sort(([a], [b]) => a.localeCompare(b));
	const secrets = [...q.data.secretKeys].sort();
	const files = q.data.secretFiles;
	const off = !gate.ok;

	return (
		<div className="max-w-4xl space-y-5 text-sm">
			{undelivered && (
				<p
					role="status"
					data-testid="env-undelivered"
					className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950"
				>
					Saved. It applies at the next start: the sandbox is not ready or its
					agent did not answer.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				New commands see changes; running ones do not. Values with a newline are
				not visible in SSH sessions.
			</p>
			<section className="space-y-2">
				<div className="flex items-center">
					<h2 className="font-medium">Environment</h2>
					<Button
						size="sm"
						variant="outline"
						className="ml-auto"
						disabled={off}
						onClick={() => setEdit({ kind: "env", key: null, value: "" })}
					>
						Add variable
					</Button>
				</div>
				<Table data-testid="env-table">
					<TableHeader>
						<TableRow>
							<TableHead className="w-64">Name</TableHead>
							<TableHead>Value</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{env.length === 0 && (
							<TableRow>
								<TableCell colSpan={3} className="text-muted-foreground">
									None.
								</TableCell>
							</TableRow>
						)}
						{env.map(([k, v]) => (
							<TableRow key={k}>
								<TableCell className="font-mono text-xs">{k}</TableCell>
								<TableCell className="max-w-md truncate font-mono text-xs">
									{v}
								</TableCell>
								<TableCell>
									<RowButtons
										off={off}
										onEdit={() => setEdit({ kind: "env", key: k, value: v })}
										what={k}
										onDelete={() =>
											patch({ env: { [k]: null } }, `${k} removed`)
										}
									/>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
			<section className="space-y-2">
				<div className="flex items-center">
					<h2 className="font-medium">Secrets</h2>
					<Button
						size="sm"
						variant="outline"
						className="ml-auto"
						disabled={off}
						onClick={() => setEdit({ kind: "secret", key: null })}
					>
						Add secret
					</Button>
				</div>
				<Table data-testid="secrets-table">
					<TableBody>
						{secrets.length === 0 && (
							<TableRow>
								<TableCell className="text-muted-foreground">None.</TableCell>
							</TableRow>
						)}
						{secrets.map((k) => (
							<TableRow key={k}>
								<TableCell className="w-64 font-mono text-xs">{k}</TableCell>
								<TableCell className="font-mono text-xs text-muted-foreground">
									•••
								</TableCell>
								<TableCell>
									<RowButtons
										off={off}
										editLabel="Set value"
										onEdit={() => setEdit({ kind: "secret", key: k })}
										what={k}
										onDelete={() =>
											patch({ secrets: { [k]: null } }, `${k} removed`)
										}
									/>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
			<section className="space-y-2">
				<div className="flex items-center">
					<h2 className="font-medium">Secret files</h2>
					<Button
						size="sm"
						variant="outline"
						className="ml-auto"
						disabled={off}
						onClick={() => setAddFile(true)}
					>
						Add secret file
					</Button>
				</div>
				<Table>
					<TableBody>
						{files.length === 0 && (
							<TableRow>
								<TableCell className="text-muted-foreground">None.</TableCell>
							</TableRow>
						)}
						{files.map((f) => (
							<TableRow key={f.name}>
								<TableCell className="w-64 font-mono text-xs">
									{f.name}
								</TableCell>
								<TableCell className="font-mono text-xs">
									{f.mode.toString(8).padStart(4, "0")}
								</TableCell>
								<TableCell className="font-mono text-xs">
									{f.linkPath ?? "—"}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{formatBytes(f.sizeBytes)}
								</TableCell>
								<TableCell>
									<div className="flex justify-end">
										<ConfirmButton
											size="xs"
											variant="ghost"
											title={`Remove ${f.name}?`}
											description="The file is removed from the sandbox's secret files."
											confirmLabel="Remove"
											disabled={off}
											onConfirm={() =>
												patch(
													{ secretFiles: { [f.name]: null } },
													`${f.name} removed`,
												)
											}
										>
											Remove
										</ConfirmButton>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
			<EditDialog
				edit={edit}
				existing={
					new Set(edit?.kind === "secret" ? secrets : env.map(([k]) => k))
				}
				onClose={() => setEdit(null)}
				onSave={(k, v) =>
					edit?.kind === "secret"
						? patch({ secrets: { [k]: v } }, `Secret ${k} saved`)
						: patch({ env: { [k]: v } }, `${k} saved`)
				}
			/>
			<SecretFileDialog
				open={addFile}
				onOpenChange={setAddFile}
				existing={new Set(files.map((f) => f.name))}
				onSave={(name, file) =>
					patch({ secretFiles: { [name]: file } }, `${name} saved`)
				}
			/>
		</div>
	);
}

function RowButtons({
	off,
	what,
	editLabel = "Edit",
	onEdit,
	onDelete,
}: {
	off: boolean;
	what: string;
	editLabel?: string;
	onEdit: () => void;
	onDelete: () => Promise<boolean>;
}) {
	return (
		<div className="flex justify-end gap-1">
			<Button size="xs" variant="ghost" disabled={off} onClick={onEdit}>
				{editLabel}
			</Button>
			<ConfirmButton
				size="xs"
				variant="ghost"
				title={`Remove ${what}?`}
				description="New commands no longer see it."
				confirmLabel="Remove"
				disabled={off}
				onConfirm={onDelete}
			>
				Remove
			</ConfirmButton>
		</div>
	);
}

function EditDialog({
	edit,
	existing,
	onClose,
	onSave,
}: {
	edit: EnvEdit | null;
	existing: Set<string>;
	onClose: () => void;
	onSave: (key: string, value: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [value, setValue] = useState<string | null>(null);
	const [show, setShow] = useState(false);
	const secret = edit?.kind === "secret";
	const isNew = edit !== null && edit.key === null;
	const k = isNew ? name.trim() : (edit?.key ?? "");
	const v = value ?? (edit?.kind === "env" ? edit.value : "");
	const problem =
		isNew && k !== ""
			? (envKeyProblem(k) ??
				(existing.has(k) ? "Exists already: edit it in the table" : null))
			: null;
	const close = () => {
		setName("");
		setValue(null);
		setShow(false);
		onClose();
	};
	return (
		<FormDialog
			open={edit !== null}
			onOpenChange={(o) => !o && close()}
			title={
				isNew
					? secret
						? "Add secret"
						: "Add variable"
					: secret
						? `Set ${k}`
						: `Edit ${k}`
			}
			description={
				secret
					? "The value is stored encrypted and never shown again; it lives on tmpfs in the guest."
					: "Stored on the sandbox's disk (copied into forks and snapshots)."
			}
			submitLabel="Save"
			submitDisabled={k === "" || problem !== null || (secret && v === "")}
			onSubmit={async () => {
				const ok = await onSave(k, v);
				if (ok) close();
				return ok;
			}}
		>
			{isNew && (
				<Field label="Name" error={problem}>
					<Input
						autoFocus
						spellCheck={false}
						autoComplete="off"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
			)}
			<Field label="Value">
				{secret ? (
					<div className="flex gap-1">
						<Input
							type={show ? "text" : "password"}
							autoComplete="new-password"
							spellCheck={false}
							value={v}
							onChange={(e) => setValue(e.target.value)}
						/>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setShow((s) => !s)}
						>
							{show ? "Hide" : "Show"}
						</Button>
					</div>
				) : (
					<textarea
						className="min-h-16 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs"
						spellCheck={false}
						value={v}
						onChange={(e) => setValue(e.target.value)}
					/>
				)}
			</Field>
		</FormDialog>
	);
}

function SecretFileDialog({
	open,
	onOpenChange,
	existing,
	onSave,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	existing: Set<string>;
	onSave: (
		name: string,
		file: { contentBase64: string; mode?: number; linkPath?: string },
	) => Promise<boolean>;
}) {
	const [file, setFile] = useState<File | null>(null);
	const [name, setName] = useState("");
	const [mode, setMode] = useState("");
	const [link, setLink] = useState("");
	const n = name.trim();
	const nameProblem = n === "" ? null : secretFileNameProblem(n);
	const parsedMode = parseSecretFileMode(mode);
	const modeProblem = parsedMode === null ? "Octal, like 0440" : null;
	const linkProblem =
		link.trim() !== "" && !link.trim().startsWith("/")
			? "An absolute path"
			: null;
	const sizeProblem =
		file && file.size > LIMITS.secretFileBytes ? "At most 1 MiB" : null;
	const reset = () => {
		setFile(null);
		setName("");
		setMode("");
		setLink("");
	};
	return (
		<FormDialog
			open={open}
			onOpenChange={(o) => {
				if (!o) reset();
				onOpenChange(o);
			}}
			title="Add secret file"
			description={
				n !== "" && existing.has(n)
					? `A secret file named ${n} exists: it is replaced.`
					: "Kept encrypted; written to tmpfs in the guest at every start."
			}
			submitLabel="Save"
			submitDisabled={
				!file ||
				n === "" ||
				!!nameProblem ||
				!!modeProblem ||
				!!linkProblem ||
				!!sizeProblem
			}
			onSubmit={async () => {
				if (!file) return false;
				const contentBase64 = bytesToBase64(
					new Uint8Array(await file.arrayBuffer()),
				);
				const ok = await onSave(n, {
					contentBase64,
					...(parsedMode === undefined || parsedMode === null
						? {}
						: { mode: parsedMode }),
					...(link.trim() === "" ? {} : { linkPath: link.trim() }),
				});
				if (ok) reset();
				return ok;
			}}
		>
			<Field label="File" error={sizeProblem}>
				<input
					type="file"
					onChange={(e) => {
						const f = e.target.files?.[0] ?? null;
						setFile(f);
						if (f && name === "") setName(secretFileName(f.name));
					}}
				/>
			</Field>
			<Field label="Name" error={nameProblem}>
				<Input
					spellCheck={false}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</Field>
			<div className="grid grid-cols-2 gap-3">
				<Field label="Mode" error={modeProblem} hint="Default 0440">
					<Input
						spellCheck={false}
						placeholder="0440"
						value={mode}
						onChange={(e) => setMode(e.target.value)}
					/>
				</Field>
				<Field
					label="Link path"
					error={linkProblem}
					hint="Optional symlink, absolute"
				>
					<Input
						spellCheck={false}
						placeholder="/home/user/.config/key.json"
						value={link}
						onChange={(e) => setLink(e.target.value)}
					/>
				</Field>
			</div>
		</FormDialog>
	);
}

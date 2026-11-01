"use client";
// Create or edit an environment (S8 §10.1, §10.2). Edit starts from GET of
// one (env values; secret values are never returned) and sends a merge
// patch: only what changed, null for removed keys and files, repositories
// whole. Secret values are write-only inputs and live in the form's state,
// which unmounts when the dialog closes.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { KvRows } from "@/features/create/kv-rows";
import { SecretFiles } from "@/features/create/secret-files";
import { formatBytes } from "@/features/sandbox/rules";
import { useUmiak } from "@/lib/api";
import type { FormErrors } from "@/lib/create-form";
import {
	type EnvironmentDetail,
	type EnvironmentFormState,
	emptyEnvironmentForm,
	formFromEnvironment,
	toCreateEnvironmentRequest,
	toEnvironmentPatch,
} from "@/lib/environment-form";
import { describeError } from "@/lib/errors";
import { RepositoryRows } from "./repository-rows";

export function EnvironmentDialog({
	teamId,
	editing,
	open,
	onOpenChange,
	onCreated,
}: {
	teamId: string;
	/** `env_...` of the environment to edit; null to create one. */
	editing: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (id: string) => void;
}) {
	const umiak = useUmiak(teamId);
	const detail = useQuery({
		queryKey: ["environments", teamId, "one", editing],
		queryFn: async ({ signal }) => {
			const { data } = await umiak.raw.GET("/v1/environments/{environment}", {
				params: { path: { environment: editing as string } },
				signal,
			});
			return data;
		},
		enabled: open && editing !== null,
		staleTime: 0,
		gcTime: 0,
	});
	const ready = editing === null || detail.data !== undefined;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				{editing !== null && detail.isError && (
					<DialogHeader>
						<DialogTitle>Edit environment</DialogTitle>
						<DialogDescription>
							Could not load it: {describeError(detail.error).message}
						</DialogDescription>
					</DialogHeader>
				)}
				{editing !== null && !ready && !detail.isError && (
					<DialogHeader>
						<DialogTitle>Edit environment</DialogTitle>
						<DialogDescription>Loading…</DialogDescription>
					</DialogHeader>
				)}
				{open && ready && (
					<EnvironmentForm
						key={editing ?? "new"}
						teamId={teamId}
						original={detail.data ?? null}
						onCreated={onCreated}
						onDone={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function EnvironmentForm({
	teamId,
	original,
	onDone,
	onCreated,
}: {
	teamId: string;
	original: EnvironmentDetail | null;
	onDone: () => void;
	onCreated?: ((id: string) => void) | undefined;
}) {
	const umiak = useUmiak(teamId);
	const queryClient = useQueryClient();
	const [form, setForm] = useState<EnvironmentFormState>(() =>
		original === null ? emptyEnvironmentForm() : formFromEnvironment(original),
	);
	const [errors, setErrors] = useState<FormErrors>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = (patch: Partial<EnvironmentFormState>) =>
		setForm((f) => ({ ...f, ...patch }));

	const send = async (): Promise<boolean> => {
		if (original === null) {
			const r = toCreateEnvironmentRequest(form);
			if (!r.ok) {
				setErrors(r.errors);
				return false;
			}
			const { data } = await umiak.raw.POST("/v1/environments", { body: r.body });
			onCreated?.(data.id);
			toast.success(`Environment ${r.body.name} created`);
			return true;
		}
		const r = toEnvironmentPatch(original, form);
		if (!r.ok) {
			setErrors(r.errors);
			return false;
		}
		if (r.empty) {
			toast.info("Nothing changed");
			return true;
		}
		await umiak.raw.PATCH("/v1/environments/{environment}", {
			params: { path: { environment: original.id } },
			body: r.body,
		});
		toast.success(`Environment ${r.body.name ?? original.name} saved`);
		return true;
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setErrors({});
		setFormError(null);
		try {
			if (await send()) {
				await queryClient.invalidateQueries({
					queryKey: ["environments", teamId],
				});
				onDone();
			}
		} catch (err) {
			const v = describeError(err);
			if (v.code === "already_exists") {
				setErrors({ name: "Another environment of the team has this name" });
			} else setFormError(v.message);
		} finally {
			setBusy(false);
		}
	};

	const toggle = (list: string[], name: string) =>
		list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

	return (
		<form method="post" onSubmit={submit} className="grid gap-5">
			<DialogHeader>
				<DialogTitle>
					{original === null
						? "New environment"
						: `Edit environment ${original.name}`}
				</DialogTitle>
				<DialogDescription>
					New sandboxes of the team get these settings at create; existing
					sandboxes keep what they got. Every member who can run commands in a
					sandbox can read the values there.
				</DialogDescription>
			</DialogHeader>

			<Section title="Name" error={errors.name}>
				<Input
					aria-label="Name"
					placeholder="production"
					className="w-72 font-mono"
					autoComplete="off"
					spellCheck={false}
					aria-invalid={errors.name !== undefined}
					value={form.name}
					onChange={(e) => set({ name: e.target.value })}
				/>
			</Section>
			<div className="grid gap-2 text-sm">
				<label className="flex items-start gap-2">
					<input
						type="checkbox"
						className="mt-0.5"
						checked={form.isDefault}
						onChange={(e) => set({ isDefault: e.target.checked })}
					/>
					<span>
						<span className="font-medium">Default for the team</span>
						<span className="block text-xs text-muted-foreground">
							Every create without an environment gets it, by API keys and CI
							too (they can pass <code>environment: null</code>). The previous
							default stops being one.
						</span>
					</span>
				</label>
				<label className="flex items-start gap-2">
					<input
						type="checkbox"
						className="mt-0.5"
						checked={form.excludeOwnerSecrets}
						onChange={(e) => set({ excludeOwnerSecrets: e.target.checked })}
					/>
					<span>
						<span className="font-medium">
							Do not pass the creator&apos;s personal secrets
						</span>
						<span className="block text-xs text-muted-foreground">
							Stored for now: the platform puts no personal credentials into
							sandboxes yet; later features (git tokens, AI credentials) will
							respect it.
						</span>
					</span>
				</label>
			</div>

			<Section title="Env variables">
				<KvRows
					label="Env"
					field="env"
					rows={form.env}
					onChange={(env) => set({ env })}
					errors={errors}
				/>
			</Section>

			<Section title="Secrets">
				{original !== null && original.secretKeys.length > 0 && (
					<div
						className="flex flex-wrap gap-1.5"
						data-testid="existing-secrets"
					>
						{original.secretKeys.map((k) => {
							const removed = form.removedSecrets.includes(k);
							return (
								<Badge
									key={k}
									variant="outline"
									className={removed ? "line-through opacity-60" : ""}
								>
									<span className="font-mono">{k}</span> •••
									<button
										type="button"
										className="ml-1 text-xs underline"
										onClick={() =>
											set({ removedSecrets: toggle(form.removedSecrets, k) })
										}
									>
										{removed ? "keep" : "remove"}
									</button>
								</Badge>
							);
						})}
					</div>
				)}
				<KvRows
					label="Secret"
					field="secrets"
					rows={form.secrets}
					onChange={(secrets) => set({ secrets })}
					errors={errors}
					secret
				/>
				<p className="text-xs text-muted-foreground">
					Values are write-only: they are never shown again.
					{original !== null &&
						" A name that exists already gets the new value; the others stay as they are."}
				</p>
			</Section>

			<Section title="Secret files">
				{original !== null && original.secretFiles.length > 0 && (
					<ul className="space-y-1 text-sm" data-testid="existing-secret-files">
						{original.secretFiles.map((f) => {
							const removed = form.removedSecretFiles.includes(f.name);
							return (
								<li
									key={f.name}
									className={`flex flex-wrap items-center gap-2 ${removed ? "line-through opacity-60" : ""}`}
								>
									<span className="font-mono">{f.name}</span>
									<span className="text-xs text-muted-foreground">
										{f.mode.toString(8).padStart(4, "0")} ·{" "}
										{formatBytes(f.sizeBytes)}
										{f.linkPath ? ` · → ${f.linkPath}` : ""}
									</span>
									<button
										type="button"
										className="text-xs underline"
										onClick={() =>
											set({
												removedSecretFiles: toggle(
													form.removedSecretFiles,
													f.name,
												),
											})
										}
									>
										{removed ? "keep" : "remove"}
									</button>
								</li>
							);
						})}
					</ul>
				)}
				<SecretFiles
					files={form.secretFiles}
					onChange={(secretFiles) => set({ secretFiles })}
					errors={errors}
				/>
			</Section>

			<Section title="Repositories">
				<RepositoryRows
					rows={form.repositories}
					onChange={(repositories) => set({ repositories })}
					errors={errors}
				/>
			</Section>

			{formError && (
				<p role="alert" className="text-sm text-destructive">
					{formError}
				</p>
			)}
			{Object.keys(errors).length > 0 && (
				<p className="text-sm text-destructive">Fix the marked fields.</p>
			)}
			<DialogFooter>
				<DialogClose asChild>
					<Button type="button" variant="outline" disabled={busy}>
						Cancel
					</Button>
				</DialogClose>
				<Button type="submit" disabled={busy}>
					{original === null ? "Create" : "Save"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function Section({
	title,
	error,
	children,
}: {
	title: string;
	error?: string | undefined;
	children: ReactNode;
}) {
	return (
		<div className="grid gap-1.5">
			<h3 className="text-sm font-medium">{title}</h3>
			{children}
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

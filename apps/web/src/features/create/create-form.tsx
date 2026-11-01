"use client";
// /app/t/<team>/sandboxes/new (S8 §9.5). Catalog from GET /v1/templates,
// /v1/sizes, /v1/snapshots, /v1/environments and /v1/limits; POST
// /v1/sandboxes through the SDK (it sets the Idempotency-Key), then the
// sandbox page, where the create operation is seen. Errors as text at the
// form; out_of_capacity offers a retry. Secrets never leave React state
// except in the request body: no URL, no storage, no logs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { SandboxList } from "@/features/sandboxes/sandbox-list";
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import {
	type CreateFormState,
	type CreatePrefill,
	type DurationChoice,
	type EnvironmentChoice,
	emptyCreateForm,
	type FormErrors,
	slugProblem,
	toCreateRequest,
} from "@/lib/create-form";
import { describeError, type ErrorView } from "@/lib/errors";
import { type IdempotencySlot, slotAfter, slotFor } from "@/lib/idempotency";
import { teamPath } from "@/lib/team-path";
import { cn } from "@/lib/utils";
import { sandboxHref } from "../sandboxes/links";
import { KvRows } from "./kv-rows";
import { SecretFiles } from "./secret-files";

const TTL_CHOICES: { value: DurationChoice; label: string }[] = [
	{ value: "default", label: "platform default" },
	{ value: "none", label: "none" },
	{ value: "3600", label: "1 hour" },
	{ value: "14400", label: "4 hours" },
	{ value: "28800", label: "8 hours" },
	{ value: "86400", label: "1 day" },
	{ value: "259200", label: "3 days" },
	{ value: "604800", label: "7 days" },
];

const IDLE_CHOICES: { value: DurationChoice; label: string }[] = [
	{ value: "default", label: "platform default" },
	{ value: "none", label: "never" },
	{ value: "300", label: "5 min" },
	{ value: "900", label: "15 min" },
	{ value: "1800", label: "30 min" },
	{ value: "3600", label: "1 hour" },
	{ value: "7200", label: "2 hours" },
	{ value: "14400", label: "4 hours" },
];

const SIZE_REASONS: Record<string, string> = {
	template_disabled: "template disabled",
	quota_active_sandboxes: "over the active sandbox quota",
	quota_ram: "over the RAM quota",
};

const ENV_DEFAULT = "__default";
const ENV_NONE = "__none";

function envValue(c: EnvironmentChoice): string {
	if (c.kind === "default") return ENV_DEFAULT;
	if (c.kind === "none") return ENV_NONE;
	return `env:${c.name}`;
}

function envChoice(v: string): EnvironmentChoice {
	if (v === ENV_NONE) return { kind: "none" };
	if (v.startsWith("env:")) return { kind: "named", name: v.slice(4) };
	return { kind: "default" };
}

function Row({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="create-field grid min-w-0 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<div className="pt-1.5 text-sm font-medium">{label}</div>
			<div className="min-w-0 space-y-1">
				{children}
				{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			</div>
		</div>
	);
}

export function CreateSandboxForm({
	teamId,
	prefill,
}: {
	teamId: string;
	prefill: CreatePrefill;
}) {
	const sbx = useSbx(teamId);
	const router = useRouter();
	const queryClient = useQueryClient();
	const [form, setForm] = useState<CreateFormState>(() => ({
		...emptyCreateForm(),
		source: prefill.snapshot ? "snapshot" : "template",
		template: prefill.template ?? "",
		snapshot: prefill.snapshot ?? "",
		size: prefill.size ?? "",
	}));
	const [errors, setErrors] = useState<FormErrors>({});
	const [submitError, setSubmitError] = useState<ErrorView | null>(null);
	const [pending, setPending] = useState(false);
	const idempotency = useRef<IdempotencySlot | null>(null);
	const patch = (p: Partial<CreateFormState>) =>
		setForm((f) => ({ ...f, ...p }));

	const templates = useQuery({
		queryKey: ["templates", teamId],
		queryFn: ({ signal }) => sbx.templates({ signal }),
	});
	const sizes = useQuery({
		queryKey: ["sizes", teamId],
		queryFn: ({ signal }) => sbx.sizes({ signal }),
	});
	const snapshots = useQuery({
		queryKey: ["snapshots", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await sbx.raw.GET("/v1/snapshots", { signal });
			return data.data;
		},
	});
	const environments = useQuery({
		queryKey: ["environments", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await sbx.raw.GET("/v1/environments", { signal });
			return data.data;
		},
	});
	const limits = useQuery({
		queryKey: ["limits", teamId],
		queryFn: ({ signal }) => sbx.limits({ signal }),
	});

	// Disabled templates are listed for operators only; nobody creates from them.
	const enabled = useMemo(
		() => (templates.data ?? []).filter((t) => t.enabled),
		[templates.data],
	);
	const readySnapshots = useMemo(
		() => (snapshots.data ?? []).filter((s) => s.state === "ready"),
		[snapshots.data],
	);
	const snapshot = readySnapshots.find((s) => s.name === form.snapshot);
	const templateSlug =
		form.source === "snapshot" ? (snapshot?.template ?? null) : form.template;
	const template = enabled.find((t) => t.slug === templateSlug);
	const sizeInfo = new Map((sizes.data ?? []).map((s) => [s.slug, s]));
	const sizeLimits = new Map(
		(
			limits.data?.templates.find((t) => t.slug === templateSlug)?.sizes ?? []
		).map((s) => [s.slug, s]),
	);
	const sizeChoices = template?.allowedSizes ?? [];

	// Pick a template, and a size of it, once the catalog is there.
	useEffect(() => {
		if (form.source !== "template" || enabled.length === 0) return;
		const t = enabled.find((x) => x.slug === form.template) ?? enabled[0];
		if (t === undefined) return;
		const size = t.allowedSizes.includes(form.size) ? form.size : t.defaultSize;
		if (t.slug !== form.template || size !== form.size) {
			setForm((f) => ({ ...f, template: t.slug, size }));
		}
	}, [enabled, form.source, form.template, form.size]);

	// From a snapshot: its size unless the user picked another allowed one.
	useEffect(() => {
		if (form.source !== "snapshot" || snapshot === undefined) return;
		const allowed = template?.allowedSizes ?? [];
		if (form.size !== "" && allowed.includes(form.size)) return;
		const size = snapshot.size ?? template?.defaultSize ?? "";
		if (size !== form.size) setForm((f) => ({ ...f, size }));
	}, [form.source, form.size, snapshot, template]);

	const submit = async (e?: FormEvent) => {
		e?.preventDefault();
		setSubmitError(null);
		const r = toCreateRequest(form);
		if (!r.ok) {
			setErrors(r.errors);
			return;
		}
		setErrors({});
		setPending(true);
		// The same key while the body is unchanged, so a retry after an
		// unknown outcome cannot create a second sandbox (lib/idempotency).
		const slot = slotFor(idempotency.current, r.body);
		let slug: string;
		try {
			// Retryable errors are retried within the dashboard's budget (api.ts).
			const sb = await sbx.sandboxes.create(r.body, {
				idempotencyKey: slot.key,
			});
			idempotency.current = slotAfter(slot, undefined);
			slug = sb.data.slug;
		} catch (err) {
			idempotency.current = slotAfter(slot, err);
			setSubmitError(describeError(err));
			setPending(false);
			return;
		}
		await attempt(() =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sandboxes", teamId] }),
				queryClient.invalidateQueries({ queryKey: ["limits", teamId] }),
			]),
		);
		router.push(sandboxHref(teamId, slug));
	};

	const slugHint =
		form.slug.trim() === "" ? null : slugProblem(form.slug.trim());
	const envs = environments.data ?? [];
	const defaultEnv = envs.find((x) => x.isDefault);

	return (
		<>
			<SandboxList teamId={teamId} />
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) router.push(teamPath(teamId));
				}}
			>
				<DialogContent className="create-dialog">
					<section className="min-w-0 space-y-4">
						<DialogHeader>
							<DialogTitle asChild>
								<h1>New sandbox</h1>
							</DialogTitle>
							<DialogDescription className="sr-only">
								Choose a template and the settings for your sandbox.
							</DialogDescription>
						</DialogHeader>
						{templates.isError && (
							<QueryError
								error={templates.error}
								what="templates"
								onRetry={() => templates.refetch()}
							/>
						)}
						<form
							method="post"
							onSubmit={submit}
							className="min-w-0 space-y-3"
							autoComplete="off"
							data-testid="create-form"
						>
							<Row label="From">
								<div className="flex flex-wrap items-center gap-4 text-sm">
									<label className="flex items-center gap-1.5">
										<input
											type="radio"
											checked={form.source === "template"}
											onChange={() => patch({ source: "template" })}
										/>
										template
									</label>
									<label className="flex items-center gap-1.5">
										<input
											type="radio"
											checked={form.source === "snapshot"}
											disabled={readySnapshots.length === 0}
											onChange={() =>
												patch({
													source: "snapshot",
													snapshot:
														form.snapshot || (readySnapshots[0]?.name ?? ""),
													size: "",
												})
											}
										/>
										saved snapshot
									</label>
									{form.source === "snapshot" && (
										<Select
											value={form.snapshot}
											onValueChange={(v) => patch({ snapshot: v, size: "" })}
										>
											<SelectTrigger
												aria-label="Saved snapshot"
												className="w-56"
											>
												<SelectValue placeholder="Pick a snapshot" />
											</SelectTrigger>
											<SelectContent>
												{readySnapshots.map((s) => (
													<SelectItem key={s.id} value={s.name}>
														{s.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								</div>
								{form.source === "snapshot" &&
									form.snapshot !== "" &&
									snapshots.data &&
									snapshot === undefined && (
										<p className="text-xs text-destructive">
											No ready snapshot named {form.snapshot}.
										</p>
									)}
								{errors.snapshot && (
									<p className="text-xs text-destructive">{errors.snapshot}</p>
								)}
							</Row>

							{form.source === "template" ? (
								<Row label="Template">
									{templates.isPending && (
										<p className="text-sm text-muted-foreground">Loading…</p>
									)}
									{templates.data && enabled.length === 0 && (
										<p className="text-sm text-muted-foreground">
											No template is available. Ask a platform operator.
										</p>
									)}
									<div className="flex flex-col gap-1 text-sm">
										{enabled.map((t) => (
											<label key={t.slug} className="flex items-center gap-1.5">
												<input
													type="radio"
													checked={form.template === t.slug}
													onChange={() =>
														patch({ template: t.slug, size: t.defaultSize })
													}
												/>
												<span className="font-medium">{t.slug}</span>
												<span className="text-muted-foreground">
													— {t.name}
												</span>
												{t.version === null && (
													<span className="text-xs text-warning">
														(no active build)
													</span>
												)}
											</label>
										))}
									</div>
								</Row>
							) : (
								<Row label="Template">
									<p className="pt-1.5 text-sm text-muted-foreground">
										{snapshot
											? `${snapshot.template ?? "?"}${snapshot.templateVersion ? ` ${snapshot.templateVersion}` : ""}, from the snapshot`
											: "From the snapshot"}
									</p>
								</Row>
							)}

							<Row label="Size">
								<Select
									value={form.size}
									onValueChange={(v) => patch({ size: v })}
									disabled={sizeChoices.length === 0}
								>
									<SelectTrigger aria-label="Size" className="w-80">
										<SelectValue placeholder="default size" />
									</SelectTrigger>
									<SelectContent>
										{sizeChoices.map((slug) => {
											const s = sizeInfo.get(slug);
											const l = sizeLimits.get(slug);
											const why =
												l && !l.allowed && l.reason
													? (SIZE_REASONS[l.reason] ?? l.reason)
													: null;
											return (
												<SelectItem key={slug} value={slug}>
													{slug}
													{s ? ` · ${s.vcpu} vCPU · ${s.memoryMb} MB` : ""}
													{why ? ` (${why})` : ""}
												</SelectItem>
											);
										})}
									</SelectContent>
								</Select>
							</Row>

							<Row
								label="Name"
								hint="Optional display name, up to 255 characters."
							>
								<Input
									aria-label="Name"
									placeholder="ci-run-42"
									className="w-80"
									maxLength={255}
									aria-invalid={errors.name !== undefined}
									value={form.name}
									onChange={(e) => patch({ name: e.target.value })}
								/>
								{errors.name && (
									<p className="text-xs text-destructive">{errors.name}</p>
								)}
							</Row>

							<Row
								label="Slug"
								hint="Used in port URLs, SSH and the hostname. Empty: three random words."
							>
								<Input
									aria-label="Slug"
									placeholder="auto: three words"
									className="w-80 font-mono"
									spellCheck={false}
									aria-invalid={slugHint !== null || errors.slug !== undefined}
									value={form.slug}
									onChange={(e) =>
										patch({ slug: e.target.value.toLowerCase() })
									}
								/>
								{(slugHint ?? errors.slug) && (
									<p className="text-xs text-destructive">
										Slug: {slugHint ?? errors.slug}
									</p>
								)}
							</Row>

							<Row
								label="Environment"
								hint="Its env, secrets and secret files are applied first; the ones below win on the same name."
							>
								<Select
									value={envValue(form.environment)}
									onValueChange={(v) => patch({ environment: envChoice(v) })}
								>
									<SelectTrigger aria-label="Environment" className="w-80">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ENV_DEFAULT}>
											{defaultEnv
												? `team default: ${defaultEnv.name}`
												: "team default (none set)"}
										</SelectItem>
										{envs.map((x) => (
											<SelectItem key={x.id} value={`env:${x.name}`}>
												{x.name}
											</SelectItem>
										))}
										<SelectItem value={ENV_NONE}>none</SelectItem>
									</SelectContent>
								</Select>
							</Row>

							<Row
								label="Labels"
								hint="For filtering and automation, key=value."
							>
								<KvRows
									label="Label"
									field="labels"
									keyPlaceholder="key"
									rows={form.labels}
									errors={errors}
									onChange={(labels) => patch({ labels })}
								/>
							</Row>

							<Row label="Env vars" hint="Visible to everyone in the team.">
								<KvRows
									label="Env var"
									field="env"
									rows={form.env}
									errors={errors}
									onChange={(env) => patch({ env })}
								/>
							</Row>

							<Row
								label="Secrets"
								hint="Env variables kept on tmpfs in the guest; their values are never shown again."
							>
								<KvRows
									label="Secret"
									field="secrets"
									secret
									rows={form.secrets}
									errors={errors}
									onChange={(secrets) => patch({ secrets })}
								/>
							</Row>

							<Row label="Secret files">
								<SecretFiles
									files={form.secretFiles}
									errors={errors}
									onChange={(secretFiles) => patch({ secretFiles })}
								/>
							</Row>

							<Row label="Lifetime">
								<div className="flex flex-wrap items-center gap-3 text-sm">
									<span>TTL</span>
									<DurationSelect
										label="TTL"
										choices={TTL_CHOICES}
										value={form.ttl}
										onChange={(ttl) => patch({ ttl })}
									/>
									<span>Idle stop after</span>
									<DurationSelect
										label="Idle stop after"
										choices={IDLE_CHOICES}
										value={form.idle}
										onChange={(idle) => patch({ idle })}
									/>
								</div>
							</Row>

							{limits.data && !limits.data.canCreate && (
								<p className="text-sm text-warning">
									The team's quota is used up: stop or delete a sandbox first.
								</p>
							)}
							{Object.keys(errors).length > 0 && (
								<p role="alert" className="text-sm text-destructive">
									Fix the fields marked above.
								</p>
							)}
							{submitError && (
								<div
									role="alert"
									data-testid="create-error"
									className={cn(
										"flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm",
										submitError.apiUnavailable || submitError.retry
											? "border-warning/35 bg-warning-tint text-warning"
											: "border-destructive/30 bg-destructive/5 text-destructive",
									)}
								>
									<p className="flex-1">{submitError.message}</p>
									{submitError.retry && (
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={pending}
											onClick={() => void submit()}
										>
											Try again
										</Button>
									)}
								</div>
							)}
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => router.push(teamPath(teamId))}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={pending}>
									{pending ? "Creating…" : "Create"}
								</Button>
							</div>
						</form>
					</section>
				</DialogContent>
			</Dialog>
		</>
	);
}

function DurationSelect({
	label,
	choices,
	value,
	onChange,
}: {
	label: string;
	choices: { value: DurationChoice; label: string }[];
	value: DurationChoice;
	onChange: (v: DurationChoice) => void;
}) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as DurationChoice)}>
			<SelectTrigger aria-label={label} className="w-40">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{choices.map((c) => (
					<SelectItem key={c.value} value={c.value}>
						{c.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

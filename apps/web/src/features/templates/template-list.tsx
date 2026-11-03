"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { setTemplateEnabled } from "@/actions/templates";
import { QueryError } from "@/components/app/query-error";
import { useAppSession } from "@/components/app/session-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CodeBlock, LoadingState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionBar, PageHeader, Panel } from "@/components/ui/panel";
import { useUmiak } from "@/lib/api";
import { teamPath } from "@/lib/team-path";

type MediaRecord = {
	templateSlug: string;
	mediaVerification?: string;
	isoSha256?: string;
	virtioSha256?: string;
};
type BuildJob = {
	id: string;
	slug: string;
	status: string;
	startedAt: string;
	log?: string;
	mediaVerification?: string;
	mediaSha256?: string;
	manifest?: MediaRecord;
	error?: string;
};
async function buildRequest(
	method = "GET",
	body?: object,
): Promise<{ buildJob?: BuildJob | null; builds?: MediaRecord[] }> {
	const r = await fetch("/quickstart/setup/build", {
		method,
		headers: { "Content-Type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const result = await r.json();
	if (!r.ok) throw new Error(result.error || "Build request failed");
	return result;
}

export function TemplateList({
	teamId,
	quickstart,
}: {
	teamId: string;
	quickstart: boolean;
}) {
	const umiak = useUmiak(teamId);
	const session = useAppSession();
	const client = useQueryClient();
	const templates = useQuery({
		queryKey: ["templates", teamId],
		queryFn: async () => (await umiak.raw.GET("/v1/templates")).data.data,
		refetchInterval: quickstart ? 3000 : false,
	});
	const jobs = useQuery({
		queryKey: ["template-build-job"],
		queryFn: () => buildRequest(),
		enabled: quickstart && session.isOperator,
		refetchInterval: 2000,
	});
	const storages = useQuery({
		queryKey: ["template-media-storages"],
		queryFn: async () => {
			const response = await fetch("/quickstart/setup/media/storages");
			if (!response.ok) throw new Error("Cannot load ISO storage");
			return (await response.json()) as { storages: { storage: string }[] };
		},
		enabled: quickstart && session.isOperator,
	});
	const [selected, setSelected] = useState<{
		slug: string;
		built: boolean;
		windows: boolean;
	} | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const job = jobs.data?.buildJob;
	const refresh = () => client.invalidateQueries({ queryKey: ["templates"] });
	return (
		<section className="space-y-5">
			<PageHeader title="Templates" />
			<p className="max-w-3xl text-sm text-muted-foreground">
				A template is a base OS image used to create sandboxes. A{" "}
				<Link href={teamPath(teamId, "snapshots")} className="underline">
					snapshot
				</Link>{" "}
				saves a sandbox disk, including your installed software and files.
				Rebuilding creates a new version in a free slot; existing sandboxes and
				snapshots keep their original disks.
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{templates.isError && (
				<QueryError
					error={templates.error}
					what="templates"
					onRetry={() => templates.refetch()}
				/>
			)}
			{templates.isPending && <LoadingState />}
			<div className="grid gap-4 xl:grid-cols-2">
				{templates.data?.map((t) => {
					const metadata = t as typeof t & {
						buildCreatedAt?: string | null;
						pveVmid?: number | null;
					};
					const current = job?.slug === t.slug ? job : undefined;
					const media = jobs.data?.builds?.find(
						(b) => b.templateSlug === t.slug,
					);
					const status =
						current?.status === "running"
							? "building"
							: current?.status === "error"
								? "failed"
								: t.version
									? "ready"
									: "not built";
					return (
						<Panel
							key={t.slug}
							data-testid="template-card"
							className="space-y-4"
						>
							<div className="flex items-center justify-between gap-3">
								<h2 className="font-semibold">{t.name || t.slug}</h2>
								<Badge
									variant={
										status === "failed"
											? "destructive"
											: status === "ready"
												? "success"
												: status === "building"
													? "warning"
													: "outline"
									}
								>
									{status}
								</Badge>
							</div>
							<dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
								<dt className="text-muted-foreground">OS</dt>
								<dd>{t.os}</dd>
								<dt className="text-muted-foreground">Capabilities</dt>
								<dd>{t.capabilities.join(", ") || "—"}</dd>
								<dt className="text-muted-foreground">Default size</dt>
								<dd>{t.defaultSize}</dd>
								<dt className="text-muted-foreground">Allowed sizes</dt>
								<dd>{t.allowedSizes.join(", ")}</dd>
								<dt className="text-muted-foreground">Enabled</dt>
								<dd>{t.enabled ? "Yes" : "No"}</dd>
								<dt className="text-muted-foreground">Active version</dt>
								<dd>{t.version || "—"}</dd>
								<dt className="text-muted-foreground">Build date</dt>
								<dd>
									{metadata.buildCreatedAt
										? new Date(metadata.buildCreatedAt).toLocaleString()
										: "—"}
								</dd>
								<dt className="text-muted-foreground">Slot / VMID</dt>
								<dd>{metadata.pveVmid ?? "—"}</dd>
							</dl>
							{media?.mediaVerification && (
								<p className="text-sm">
									ISO source: {media.mediaVerification}
									{media.isoSha256 && (
										<span className="block break-all text-xs">
											Windows SHA256: {media.isoSha256}
										</span>
									)}
									{media.virtioSha256 && (
										<span className="block break-all text-xs">
											VirtIO SHA256: {media.virtioSha256}
										</span>
									)}
								</p>
							)}
							{session.isOperator && (
								<ActionBar>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={async () => {
											setBusy(true);
											setError("");
											try {
												const r = await setTemplateEnabled({
													slug: t.slug,
													enabled: !t.enabled,
												});
												if ("error" in r) setError(r.error.message);
												await refresh();
											} catch (e) {
												setError(String(e));
											} finally {
												setBusy(false);
											}
										}}
									>
										{t.enabled ? "Disable" : "Enable"}
									</Button>
									{quickstart ? (
										<Button
											size="sm"
											variant="default"
											disabled={job?.status === "running"}
											onClick={() => {
												setError("");
												setSelected({
													slug: t.slug,
													built: Boolean(t.version),
													windows: t.os === "windows",
												});
											}}
										>
											{t.version ? "Rebuild…" : "Build…"}
										</Button>
									) : (
										<Button asChild size="sm">
											<Link href="/app/getting-started">
												Build instructions
											</Link>
										</Button>
									)}
								</ActionBar>
							)}
						</Panel>
					);
				})}
			</div>
			{quickstart && jobs.isError && (
				<QueryError
					error={jobs.error}
					what="build progress"
					onRetry={() => jobs.refetch()}
				/>
			)}
			{job && (
				<div className="space-y-3 rounded-none border p-5" aria-live="polite">
					<h2 className="font-semibold">
						Latest build: {job.slug} — {job.status}
					</h2>
					<p className="text-sm text-muted-foreground">
						Started {new Date(job.startedAt).toLocaleString()}. Builds run
						serially. You can reload this page safely.
					</p>
					{(job.mediaVerification || job.manifest?.mediaVerification) ===
						"unverified" && (
						<p role="status" className="text-sm">
							Not verified: the ISO will be used as downloaded
						</p>
					)}
					{(job.mediaSha256 || job.manifest?.isoSha256) && (
						<p className="break-all text-xs">
							ISO SHA256: {job.mediaSha256 || job.manifest?.isoSha256}
						</p>
					)}
					{job.error && (
						<p role="alert" className="text-destructive">
							{job.error}
						</p>
					)}
					<CodeBlock
						data-testid="template-build-log"
						className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-muted p-3 text-xs"
					>
						{job.log || "Waiting for builder output…"}
					</CodeBlock>
				</div>
			)}
			<Dialog
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
			>
				<DialogContent className="max-h-[90vh] overflow-auto">
					<DialogTitle>
						{selected?.built ? "Rebuild" : "Build"} {selected?.slug}?
					</DialogTitle>
					{selected && (
						<form
							id="template-build-form"
							className="space-y-4"
							onSubmit={async (event) => {
								event.preventDefault();
								setBusy(true);
								setError("");
								const data = Object.fromEntries(
									new FormData(event.currentTarget),
								);
								try {
									await buildRequest("POST", {
										...data,
										slug: selected.slug,
										...(selected.built
											? { confirmRebuild: selected.slug }
											: {}),
										allowInternalIsoUrls: data.allowInternalIsoUrls === "on",
									});
									setSelected(null);
									await jobs.refetch();
								} catch (e) {
									setError(e instanceof Error ? e.message : String(e));
								} finally {
									setBusy(false);
								}
							}}
						>
							<p className="text-sm text-muted-foreground">
								This starts a VM build and uses host RAM. A rebuild requires
								another free template slot. The active template and running
								sandboxes are preserved. On the dev stand, rebuilding templates
								595–598 requires the master's approval.
							</p>
							{selected.windows && (
								<>
									<p className="text-sm">
										Umiak never ships or hosts Windows media. Supply your own
										licensed ISO URL or an already uploaded ISO. Without SHA256:
										Not verified: the ISO will be used as downloaded.
									</p>
									<label
										htmlFor="template-list-choice-1"
										className="block text-sm"
									>
										ISO storage
										<NativeSelect
											id="template-list-choice-1"
											name="mediaStorage"
											className="mt-1 block w-full border bg-background p-2"
											aria-label="ISO storage"
										>
											<option value="">First eligible ISO storage</option>
											{storages.data?.storages.map((s) => (
												<option key={s.storage} value={s.storage}>
													{s.storage}
												</option>
											))}
										</NativeSelect>
									</label>
									<label htmlFor="tpl-isoUrl" className="block text-sm">
										Windows ISO HTTPS URL
										<Input
											id="tpl-isoUrl"
											name="isoUrl"
											type="url"
											placeholder="https://…/windows.iso"
										/>
									</label>
									<label htmlFor="tpl-iso" className="block text-sm">
										Or existing ISO path / PVE volume
										<Input
											id="tpl-iso"
											name="iso"
											placeholder="local:iso/windows.iso"
										/>
									</label>
									<label htmlFor="tpl-isoSha256" className="block text-sm">
										Windows ISO SHA256 (optional)
										<Input
											id="tpl-isoSha256"
											name="isoSha256"
											pattern="[a-fA-F0-9]{64}"
										/>
									</label>
									<label htmlFor="tpl-virtioUrl" className="block text-sm">
										VirtIO ISO HTTPS URL
										<Input
											id="tpl-virtioUrl"
											name="virtioUrl"
											defaultValue="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso"
										/>
									</label>
									<label htmlFor="tpl-virtioSha256" className="block text-sm">
										VirtIO ISO SHA256 (optional)
										<Input
											id="tpl-virtioSha256"
											name="virtioSha256"
											pattern="[a-fA-F0-9]{64}"
										/>
									</label>
									<label
										htmlFor="template-list-choice-2"
										className="flex gap-2 text-sm"
									>
										<Checkbox
											id="template-list-choice-2"
											name="allowInternalIsoUrls"
										/>
										Explicitly allow private/internal ISO URL targets
									</label>
								</>
							)}
							{selected.windows && (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={async () => {
										setBusy(true);
										setError("");
										try {
											const form = document.querySelector<HTMLFormElement>(
												"#template-build-form",
											);
											if (!form) return;
											const data = Object.fromEntries(new FormData(form));
											const response = await fetch(
												"/quickstart/setup/media/validate",
												{
													method: "POST",
													headers: { "Content-Type": "application/json" },
													body: JSON.stringify({
														...data,
														allowInternalIsoUrls:
															data.allowInternalIsoUrls === "on",
													}),
												},
											);
											const result = await response.json();
											setError(
												response.ok
													? `${result.message}. No download or build was started.`
													: result.error,
											);
										} catch (e) {
											setError(String(e));
										} finally {
											setBusy(false);
										}
									}}
								>
									Validate ISO inputs only
								</Button>
							)}
							{error && (
								<p role="status" className="text-sm">
									{error}
								</p>
							)}
							<label
								htmlFor="template-list-choice-3"
								className="flex gap-2 text-sm"
							>
								<Checkbox id="template-list-choice-3" required />I confirm
								starting this {selected.built ? "new version build" : "build"}.
							</label>
							<Button type="submit" disabled={busy}>
								{busy
									? "Starting…"
									: selected.built
										? "Confirm rebuild"
										: "Confirm build"}
							</Button>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}

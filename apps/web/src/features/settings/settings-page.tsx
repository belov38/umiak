import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { AccountSettings } from "@/components/app/account-settings";
import { DeploymentSettings } from "@/components/app/deployment-settings";
import { useAppSession } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { LoadingState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import Link from "@/components/ui/link";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader, Panel } from "@/components/ui/panel";
import { settingsCall } from "@/lib/settings";
import { teamPath } from "@/lib/team-path";

type RecordValue = Record<string, unknown>;
const sections = [
	"workspaces",
	"templates",
	"sizes",
	"platform-defaults",
	"account",
	"deployment",
];
const label = (key: string) =>
	key
		.replace(/([A-Z])/g, " $1")
		.replaceAll("-", " ")
		.replace(/^./, (c) => c.toUpperCase());
function Fields({
	value,
	onChange,
	lockedSlug = false,
}: {
	value: RecordValue;
	onChange: (next: RecordValue) => void;
	lockedSlug?: boolean;
}) {
	const prefix = useId();
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{Object.entries(value).map(([key, item]) => {
				const set = (next: unknown) => onChange({ ...value, [key]: next });
				if (item !== null && typeof item === "object" && !Array.isArray(item))
					return (
						<fieldset
							className="space-y-3 rounded-none border p-3 sm:col-span-2"
							key={key}
						>
							<legend>{label(key)}</legend>
							<Fields value={item as RecordValue} onChange={set} />
						</fieldset>
					);
				return (
					<label
						key={key}
						htmlFor={`${prefix}-${key}`}
						className="grid gap-1 text-sm"
					>
						{label(key)}
						{["publicPortsEnabled", "publicDesktopEnabled", "enabled"].includes(
							key,
						) ? (
							<NativeSelect
								id={`${prefix}-${key}`}
								value={item == null ? "" : String(item)}
								onChange={(e) =>
									set(e.target.value === "" ? null : e.target.value === "true")
								}
							>
								<option value="">Default</option>
								<option value="true">Enabled</option>
								<option value="false">Disabled</option>
							</NativeSelect>
						) : typeof item === "boolean" ? (
							<Checkbox
								id={`${prefix}-${key}`}
								className="h-4 w-4"
								checked={item}
								onChange={(e) => set(e.target.checked)}
							/>
						) : (
							<Input
								id={`${prefix}-${key}`}
								disabled={lockedSlug && key === "slug"}
								type={
									typeof item === "number" ||
									/Seconds$|Days$|Mb$|Sandboxes$|Snapshots$|Hours$|PerSecond$|PerMinute$|burst$|maxOwnedTeamsPerUser$|sortOrder$/.test(
										key,
									)
										? "number"
										: "text"
								}
								value={
									Array.isArray(item) || key === "capabilities"
										? (Array.isArray(item) ? item : []).join(", ")
										: item == null
											? ""
											: String(item)
								}
								onChange={(e) => {
									const text = e.target.value;
									set(
										Array.isArray(item) || key === "capabilities"
											? text
													.split(",")
													.map((s) => s.trim())
													.filter(Boolean)
											: e.target.type === "number"
												? text === ""
													? null
													: Number(text)
												: text === "" && item === null
													? null
													: text,
									);
								}}
							/>
						)}
					</label>
				);
			})}
		</div>
	);
}
function Editor({
	initial,
	save,
	lockedSlug = false,
}: {
	initial: RecordValue;
	save: (value: RecordValue) => Promise<unknown>;
	lockedSlug?: boolean;
}) {
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await save(value);
			toast.success("Settings saved");
		} catch (error) {
			setError(error instanceof Error ? error.message : "Save failed");
		} finally {
			setBusy(false);
		}
	}
	return (
		<form className="space-y-4" onSubmit={submit}>
			<Fields value={value} onChange={setValue} lockedSlug={lockedSlug} />
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			<Button disabled={busy} type="submit">
				{busy ? "Saving…" : "Save"}
			</Button>
		</form>
	);
}
function Catalog({ kind }: { kind: "templates" | "sizes" }) {
	const client = useQueryClient();
	const data = useQuery({
		queryKey: ["settings", kind],
		queryFn: () => settingsCall<RecordValue[]>(kind),
	});
	const [creating, setCreating] = useState(false);
	const reload = () => client.invalidateQueries();
	if (data.isPending) return <LoadingState />;
	if (data.error) return <p role="alert">{data.error.message}</p>;
	const initial =
		kind === "sizes"
			? { slug: "", vcpu: 2, memoryMb: 2048, sortOrder: 0 }
			: {
					slug: "",
					name: "",
					description: "",
					os: "linux",
					enabled: true,
					defaultSize: "2gb",
					allowedSizes: ["2gb"],
					loginUser: "user",
					capabilities: ["exec", "files", "ssh"],
					sortOrder: 0,
				};
	return (
		<div className="space-y-5">
			<Button onClick={() => setCreating((v) => !v)}>
				Add {kind === "sizes" ? "size" : "template"}
			</Button>
			{creating && (
				<Panel className="p-5">
					<Editor
						initial={initial}
						save={async (value) => {
							await settingsCall(kind, "POST", value);
							setCreating(false);
							await reload();
						}}
					/>
				</Panel>
			)}
			{data.data.map((item) => (
				<Panel key={String(item.slug)} className="space-y-4 p-5">
					<h2 className="font-semibold">{String(item.name ?? item.slug)}</h2>
					<Editor
						lockedSlug
						initial={item}
						save={async ({ slug, ...value }) => {
							await settingsCall(
								`${kind}/${encodeURIComponent(String(slug))}`,
								"PATCH",
								value,
							);
							await reload();
						}}
					/>
					<Button
						variant="outline"
						onClick={async () => {
							if (!window.confirm(`Delete ${item.slug}?`)) return;
							try {
								await settingsCall(
									`${kind}/${encodeURIComponent(String(item.slug))}`,
									"DELETE",
								);
								await reload();
							} catch (error) {
								toast.error(
									error instanceof Error ? error.message : "Delete failed",
								);
							}
						}}
					>
						Delete
					</Button>
				</Panel>
			))}
		</div>
	);
}
function Workspaces() {
	const client = useQueryClient();
	const teams = useQuery({
		queryKey: ["settings", "teams"],
		queryFn: () =>
			settingsCall<
				(RecordValue & {
					id: string;
					name: string;
					personal: boolean;
					role: string | null;
				})[]
			>("teams"),
	});
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	if (teams.isPending) return <LoadingState />;
	if (teams.error) return <p role="alert">{teams.error.message}</p>;
	async function action(path: string, method: string, body?: unknown) {
		await settingsCall(path, method, body);
		await client.invalidateQueries();
	}
	return (
		<div className="space-y-5">
			<form
				className="flex gap-2"
				onSubmit={async (e) => {
					e.preventDefault();
					try {
						await settingsCall("teams", "POST", { name });
						setName("");
						setError("");
						await client.invalidateQueries();
					} catch (error) {
						setError(error instanceof Error ? error.message : "Create failed");
					}
				}}
			>
				<Input
					aria-label="Workspace name"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Workspace name"
				/>
				<Button>Create workspace</Button>
			</form>
			{error && <p role="alert">{error}</p>}
			{teams.data.map((team) => (
				<Panel key={team.id} className="space-y-4 p-5">
					<Link className="font-semibold underline" href={teamPath(team.id)}>
						{team.name}
					</Link>
					<Editor
						initial={{ name: team.name, quota: team.quota }}
						save={(value) => action(`teams/${team.id}`, "PATCH", value)}
					/>
					<div className="flex gap-3">
						<Button
							variant="outline"
							disabled={team.role === null}
							onClick={() =>
								action("account", "PATCH", { defaultTeamId: team.id }).catch(
									(error) => toast.error(error.message),
								)
							}
						>
							Use by default
						</Button>
						{!team.personal && (
							<Button
								variant="outline"
								onClick={() => {
									if (window.confirm(`Delete workspace ${team.name}?`))
										void action(`teams/${team.id}`, "DELETE").catch((error) =>
											toast.error(error.message),
										);
								}}
							>
								Delete workspace
							</Button>
						)}
					</div>
				</Panel>
			))}
		</div>
	);
}
function GlobalDefaults() {
	const client = useQueryClient();
	const data = useQuery({
		queryKey: ["settings", "defaults"],
		queryFn: () => settingsCall<RecordValue>("platform-defaults"),
	});
	if (data.isPending) return <LoadingState />;
	if (data.error) return <p role="alert">{data.error.message}</p>;
	return (
		<Panel className="p-5">
			<Editor
				initial={data.data}
				save={async (value) => {
					await settingsCall("platform-defaults", "PUT", value);
					await client.invalidateQueries();
				}}
			/>
		</Panel>
	);
}
export function SettingsPage({ section = "workspaces" }: { section?: string }) {
	const session = useAppSession();
	const current = sections.includes(section) ? section : "workspaces";
	return (
		<div className="space-y-6">
			<PageHeader title="Settings" />
			<nav className="flex flex-wrap gap-4">
				{sections.map((item) => (
					<Link
						key={item}
						className={
							item === current
								? "font-semibold underline"
								: "text-muted-foreground"
						}
						href={`/app/settings/${item}`}
					>
						{label(item)}
					</Link>
				))}
				<Link href={teamPath(session.defaultTeamId, "keys")}>API keys</Link>
			</nav>
			{current === "templates" || current === "sizes" ? (
				<Catalog key={current} kind={current} />
			) : current === "platform-defaults" ? (
				<GlobalDefaults />
			) : current === "account" ? (
				<AccountSettings signOutHref="/owner/logout" />
			) : current === "deployment" ? (
				<DeploymentSettings teamId={session.defaultTeamId} />
			) : (
				<Workspaces />
			)}
		</div>
	);
}

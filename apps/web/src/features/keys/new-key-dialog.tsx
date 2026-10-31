"use client";
// Issue a team key (S8 §9.8, S7 §7.2): name, a preset (read-only, ci,
// full) or scopes by hand, lifetime (90 days by default, at most 365).
import { PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSbx } from "@/lib/api";
import {
	emptyKeyForm,
	KEY_DAYS_MAX,
	type NewKeyForm,
	PRESET_NAMES,
	PRESETS,
	type PresetName,
	SCOPES,
	type Scope,
	toCreateKeyRequest,
} from "@/lib/api-keys";
import { describeError } from "@/lib/errors";
import type { ShownSecret } from "./secret-dialog";

const PRESET_TEXT: Record<PresetName, string> = {
	"read-only": "read sandboxes, commands, files, snapshots, environments",
	ci: "create, run and delete sandboxes, files, ports; no SSH, no snapshot writes",
	full: "everything, including environments and keys:admin",
};

export function NewKeyDialog({
	teamId,
	onIssued,
}: {
	teamId: string;
	onIssued: (s: ShownSecret) => void | Promise<void>;
}) {
	const sbx = useSbx(teamId);
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<NewKeyForm>(emptyKeyForm);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const toggleScope = (s: Scope, on: boolean) =>
		setForm((f) => ({
			...f,
			scopes: on ? [...f.scopes, s] : f.scopes.filter((x) => x !== s),
		}));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const r = toCreateKeyRequest(form);
		if (!r.ok) {
			setError(r.error);
			return;
		}
		setError(null);
		setBusy(true);
		try {
			const { data } = await sbx.raw.POST("/v1/api-keys", { body: r.body });
			setOpen(false);
			setForm(emptyKeyForm());
			await onIssued({
				keyName: data.apiKey.name,
				secret: data.secret,
				rotated: false,
			});
		} catch (err) {
			setError(describeError(err).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (busy) return;
				setOpen(o);
				if (!o) setError(null);
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<PlusIcon />
					New key
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<form method="post" onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>New team API key</DialogTitle>
						<DialogDescription>
							For CI and agents. It belongs to the team and keeps working if you
							leave it.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Key name"
						placeholder="Name, e.g. ci-main"
						maxLength={64}
						autoComplete="off"
						value={form.name}
						onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
					/>
					<fieldset className="space-y-1.5 text-sm">
						<legend className="mb-1 font-medium">Access</legend>
						{PRESET_NAMES.map((p) => (
							<label key={p} className="flex items-start gap-2">
								<input
									type="radio"
									className="mt-1"
									checked={form.preset === p}
									onChange={() => setForm((f) => ({ ...f, preset: p }))}
								/>
								<span>
									<span className="font-medium">{p}</span>{" "}
									<span className="text-muted-foreground">
										— {PRESET_TEXT[p]}
									</span>
								</span>
							</label>
						))}
						<label className="flex items-center gap-2">
							<input
								type="radio"
								checked={form.preset === "custom"}
								onChange={() =>
									setForm((f) => ({
										...f,
										preset: "custom",
										scopes:
											f.scopes.length > 0
												? f.scopes
												: [...PRESETS[f.preset === "custom" ? "ci" : f.preset]],
									}))
								}
							/>
							<span className="font-medium">custom scopes</span>
						</label>
						{form.preset === "custom" && (
							<div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-6">
								{SCOPES.map((s) => (
									<label key={s} className="flex items-center gap-1.5">
										<input
											type="checkbox"
											checked={form.scopes.includes(s)}
											onChange={(e) => toggleScope(s, e.target.checked)}
										/>
										<code className="text-xs">{s}</code>
									</label>
								))}
							</div>
						)}
					</fieldset>
					<div className="flex items-center gap-2 text-sm">
						<label htmlFor="new-key-days" className="font-medium">
							Expires in
						</label>
						<Input
							id="new-key-days"
							type="number"
							min={1}
							max={KEY_DAYS_MAX}
							className="w-24"
							value={form.days}
							onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
						/>
						<span className="text-muted-foreground">
							days (at most {KEY_DAYS_MAX})
						</span>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={busy}>
							Create key
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

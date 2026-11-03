"use client";
// Issue a team key (S8 §9.8, S7 §7.2): name, a preset (read-only, ci,
// full) or scopes by hand, lifetime (90 days by default, at most 365).
import { PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useSingleOwner } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import { Checkbox, Radio } from "@/components/ui/choice";
import { Input } from "@/components/ui/input";
import { useUmiak } from "@/lib/api";
import {
	emptyKeyForm,
	KEY_DAYS_MAX,
	type NewKeyForm as KeyFormState,
	PRESET_NAMES,
	PRESETS,
	type PresetName,
	SCOPES,
	type Scope,
	toCreateKeyRequest,
} from "@/lib/api-keys";
import { useDescribeError } from "@/lib/use-error";
import type { ShownSecret } from "./secret-dialog";

const PRESET_TEXT: Record<PresetName, string> = {
	"read-only": "read sandboxes, commands, files, snapshots, environments",
	ci: "create, run and delete sandboxes, files, ports; no SSH, no snapshot writes",
	full: "everything, including environments and keys:admin",
};

export function NewKeyForm({
	teamId,
	onIssued,
}: {
	teamId: string;
	onIssued: (s: ShownSecret) => void | Promise<void>;
}) {
	const describeError = useDescribeError();
	const singleOwner = useSingleOwner();
	const umiak = useUmiak(teamId);
	const [form, setForm] = useState<KeyFormState>(emptyKeyForm);
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
			const { data } = await umiak.raw.POST("/v1/api-keys", { body: r.body });
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
		<form
			method="post"
			onSubmit={submit}
			className="key-form"
			aria-label={singleOwner ? "New API key" : "New team API key"}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<label
					htmlFor="new-key-name"
					className="grid min-w-0 content-start gap-2"
				>
					Key name
					<Input
						id="new-key-name"
						aria-label="Key name"
						placeholder="Name, e.g. ci-main"
						maxLength={64}
						autoComplete="off"
						value={form.name}
						onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
					/>
				</label>
				<div className="grid content-start gap-2 text-sm">
					<label htmlFor="new-key-days" className="font-medium">
						Expires in
					</label>
					<Input
						id="new-key-days"
						type="number"
						min={1}
						max={KEY_DAYS_MAX}
						className="w-full"
						value={form.days}
						onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
					/>
					<span className="text-muted-foreground">
						days (at most {KEY_DAYS_MAX})
					</span>
				</div>
			</div>
			<div>
				<p id="key-access-label" className="mb-2 text-xs">
					Access
				</p>
				<fieldset aria-labelledby="key-access-label" className="text-sm">
					{PRESET_NAMES.map((p) => (
						<label
							htmlFor={`new-key-form-choice-1-${p}`}
							key={p}
							className="key-preset flex items-start gap-3"
						>
							<Radio
								id={`new-key-form-choice-1-${p}`}
								className="mt-1"
								checked={form.preset === p}
								onChange={() => setForm((f) => ({ ...f, preset: p }))}
							/>
							<span>
								<span className="key-preset-title block font-medium">{p}</span>
								<span className="mt-1 block text-muted-foreground">
									{PRESET_TEXT[p]}
								</span>
								{form.preset === p && (
									<span className="mt-3 flex flex-wrap gap-2">
										{PRESETS[p].map((scope) => (
											<span key={scope} className="bg-muted px-1 text-xs">
												{scope}
											</span>
										))}
									</span>
								)}
							</span>
						</label>
					))}
					<label
						htmlFor="new-key-form-choice-2"
						className="key-preset flex items-center gap-3"
					>
						<Radio
							id="new-key-form-choice-2"
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
								<label
									htmlFor={`new-key-form-choice-3-${s}`}
									key={s}
									className="flex items-center gap-1.5"
								>
									<Checkbox
										id={`new-key-form-choice-3-${s}`}
										checked={form.scopes.includes(s)}
										onChange={(e) => toggleScope(s, e.target.checked)}
									/>
									<code className="text-xs">{s}</code>
								</label>
							))}
						</div>
					)}
				</fieldset>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div>
				<Button type="submit" disabled={busy}>
					<PlusIcon /> Create key
				</Button>
			</div>
		</form>
	);
}

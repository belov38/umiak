"use client";
// Rows of key/value pairs of the create form: labels, env, secrets. Secret
// values are `type=password` with a show toggle per row (S8 §9.5). Inputs
// have no `name`: a form submitted before hydration sends none of them.
import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormErrors, KvRow } from "@/lib/create-form";

export function KvRows({
	label,
	field,
	rows,
	onChange,
	errors,
	secret = false,
	keyPlaceholder = "KEY",
	valuePlaceholder = "value",
}: {
	label: string;
	/** Prefix of the error keys: `env` → `env.0`. */
	field: string;
	rows: KvRow[];
	onChange: (rows: KvRow[]) => void;
	errors: FormErrors;
	secret?: boolean;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
}) {
	const [shown, setShown] = useState<Set<number>>(() => new Set());
	const set = (i: number, patch: Partial<KvRow>) =>
		onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	const remove = (i: number) => {
		const next = rows.filter((_, j) => j !== i);
		onChange(next.length === 0 ? [{ key: "", value: "" }] : next);
		setShown(new Set());
	};
	const toggle = (i: number) =>
		setShown((s) => {
			const n = new Set(s);
			if (n.has(i)) n.delete(i);
			else n.add(i);
			return n;
		});

	return (
		<div className="space-y-1.5">
			{rows.map((r, i) => {
				const err = errors[`${field}.${i}`];
				const visible = shown.has(i);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
					<div key={i} className="space-y-0.5">
						<div className="kv-row flex min-w-0 items-center gap-1.5">
							<Input
								aria-label={`${label} ${i + 1} name`}
								placeholder={keyPlaceholder}
								className="w-0 flex-[2] font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={err !== undefined}
								value={r.key}
								onChange={(e) => set(i, { key: e.target.value })}
							/>
							<Input
								aria-label={`${label} ${i + 1} value`}
								placeholder={secret ? "•••" : valuePlaceholder}
								className="w-0 flex-[3] font-mono"
								type={secret && !visible ? "password" : "text"}
								autoComplete={secret ? "new-password" : "off"}
								spellCheck={false}
								data-secret={secret ? "" : undefined}
								value={r.value}
								onChange={(e) => set(i, { value: e.target.value })}
							/>
							{secret && (
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label={visible ? "Hide value" : "Show value"}
									aria-pressed={visible}
									onClick={() => toggle(i)}
								>
									{visible ? <EyeOffIcon /> : <EyeIcon />}
								</Button>
							)}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove ${label} ${i + 1}`}
								onClick={() => remove(i)}
							>
								<XIcon />
							</Button>
						</div>
						{err && <p className="text-xs text-destructive">{err}</p>}
					</div>
				);
			})}
			{errors[field] && (
				<p className="text-xs text-destructive">{errors[field]}</p>
			)}
			<Button
				type="button"
				size="xs"
				variant="ghost"
				onClick={() => onChange([...rows, { key: "", value: "" }])}
			>
				<PlusIcon />
				Add
			</Button>
		</div>
	);
}

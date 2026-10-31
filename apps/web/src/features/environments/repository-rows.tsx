"use client";
// Repositories of an environment (S8 §10.1): URL, branch or tag, path in
// the home of `user`; up to 20. Stored only in the MVP (cloning: S13). The
// URL must not carry credentials: every reader of the environment sees it.
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormErrors } from "@/lib/create-form";
import { MAX_REPOSITORIES, type RepositoryRow } from "@/lib/environment-form";

export function RepositoryRows({
	rows,
	onChange,
	errors,
}: {
	rows: RepositoryRow[];
	onChange: (rows: RepositoryRow[]) => void;
	errors: FormErrors;
}) {
	const set = (i: number, patch: Partial<RepositoryRow>) =>
		onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	const remove = (i: number) => {
		const next = rows.filter((_, j) => j !== i);
		onChange(next.length === 0 ? [{ url: "", branch: "", path: "" }] : next);
	};
	return (
		<div className="space-y-1.5">
			{rows.map((r, i) => {
				const at = `repositories.${i}`;
				const errs = [
					errors[`${at}.url`],
					errors[`${at}.branch`],
					errors[`${at}.path`],
				].filter(Boolean);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
					<div key={i} className="space-y-0.5" data-testid="repository-row">
						<div className="flex flex-wrap items-center gap-1.5">
							<Input
								aria-label={`Repository ${i + 1} URL`}
								placeholder="https://github.com/acme/web.git or git@host:org/repo.git"
								className="w-96 font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={errors[`${at}.url`] !== undefined}
								value={r.url}
								onChange={(e) => set(i, { url: e.target.value })}
							/>
							<Input
								aria-label={`Repository ${i + 1} branch`}
								placeholder="branch or tag"
								className="w-32 font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={errors[`${at}.branch`] !== undefined}
								value={r.branch}
								onChange={(e) => set(i, { branch: e.target.value })}
							/>
							<Input
								aria-label={`Repository ${i + 1} path`}
								placeholder="path (repo name)"
								className="w-40 font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={errors[`${at}.path`] !== undefined}
								value={r.path}
								onChange={(e) => set(i, { path: e.target.value })}
							/>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove repository ${i + 1}`}
								onClick={() => remove(i)}
							>
								<XIcon />
							</Button>
						</div>
						{errs.length > 0 && (
							<p className="text-xs text-destructive">{errs.join("; ")}</p>
						)}
					</div>
				);
			})}
			{errors.repositories && (
				<p className="text-xs text-destructive">{errors.repositories}</p>
			)}
			<Button
				type="button"
				size="xs"
				variant="ghost"
				disabled={rows.length >= MAX_REPOSITORIES}
				onClick={() => onChange([...rows, { url: "", branch: "", path: "" }])}
			>
				<PlusIcon />
				Add
			</Button>
			<p className="text-xs text-muted-foreground">
				Up to {MAX_REPOSITORIES}. Stored for now; cloning into new sandboxes and
				private repositories come later. No credentials or tokens in the URL.
			</p>
		</div>
	);
}

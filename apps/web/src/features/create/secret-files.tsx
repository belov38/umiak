"use client";
// Secret files of the create form (S8 §9.5, S7 §8.3): picked files are read
// into memory as base64 and kept only in React state until the create
// request; their content is never shown. Name, mode and link path per file.
import { UploadIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	bytesToBase64,
	type FormErrors,
	LIMITS,
	type SecretFileDraft,
	secretFileName,
} from "@/lib/create-form";

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function SecretFiles({
	files,
	onChange,
	errors,
}: {
	files: SecretFileDraft[];
	onChange: (files: SecretFileDraft[]) => void;
	errors: FormErrors;
}) {
	const input = useRef<HTMLInputElement>(null);
	const set = (i: number, patch: Partial<SecretFileDraft>) =>
		onChange(files.map((f, j) => (j === i ? { ...f, ...patch } : f)));

	const pick = async (list: FileList | null) => {
		if (list === null) return;
		const added: SecretFileDraft[] = [];
		for (const file of Array.from(list)) {
			if (file.size > LIMITS.secretFileBytes) {
				toast.error(`${file.name} is larger than 1 MiB`);
				continue;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				added.push({
					name: secretFileName(file.name),
					mode: "",
					linkPath: "",
					contentBase64: bytesToBase64(bytes),
					sizeBytes: bytes.byteLength,
				});
			} catch {
				toast.error(`Could not read ${file.name}`);
			}
		}
		onChange([...files, ...added]);
		if (input.current) input.current.value = "";
	};

	return (
		<div className="space-y-1.5">
			{files.map((f, i) => {
				const at = `secretFiles.${i}`;
				const errs = [
					errors[`${at}.name`],
					errors[`${at}.mode`],
					errors[`${at}.linkPath`],
					errors[`${at}.content`],
				].filter(Boolean);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: files have no identity
					<div key={i} className="space-y-0.5" data-testid="secret-file">
						<div className="flex flex-wrap items-center gap-1.5">
							<Input
								aria-label={`Secret file ${i + 1} name`}
								className="w-44 font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={errors[`${at}.name`] !== undefined}
								value={f.name}
								onChange={(e) => set(i, { name: e.target.value })}
							/>
							<Input
								aria-label={`Secret file ${i + 1} mode`}
								placeholder="0440"
								className="w-20 font-mono"
								autoComplete="off"
								aria-invalid={errors[`${at}.mode`] !== undefined}
								value={f.mode}
								onChange={(e) => set(i, { mode: e.target.value })}
							/>
							<Input
								aria-label={`Secret file ${i + 1} link path`}
								placeholder="link path, e.g. /home/user/.config/key.json"
								className="w-80 font-mono"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={errors[`${at}.linkPath`] !== undefined}
								value={f.linkPath}
								onChange={(e) => set(i, { linkPath: e.target.value })}
							/>
							<span className="text-xs text-muted-foreground">
								{formatBytes(f.sizeBytes)}
							</span>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove secret file ${f.name}`}
								onClick={() => onChange(files.filter((_, j) => j !== i))}
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
			{errors.secretFiles && (
				<p className="text-xs text-destructive">{errors.secretFiles}</p>
			)}
			<input
				ref={input}
				type="file"
				multiple
				className="sr-only"
				aria-label="Secret files to upload"
				tabIndex={-1}
				onChange={(e) => void pick(e.target.files)}
			/>
			<Button
				type="button"
				size="xs"
				variant="ghost"
				onClick={() => input.current?.click()}
			>
				<UploadIcon />
				Upload
			</Button>
			<p className="text-xs text-muted-foreground">
				Up to 32 files, 1 MiB each, 8 MiB in total. They live on tmpfs in the
				guest (mode 0440 by default); a link path adds a symlink to the file.
			</p>
		</div>
	);
}

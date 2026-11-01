// Text for a person (TTY output): tables and one-line summaries of the API
// resources. JSON output never goes through here.

import type { SandboxData } from "@umiak/sdk";

/** Columns padded to the widest cell; the last column is not padded. */
export function table(headers: string[], rows: (string | null)[][]): string {
	const cells = [headers, ...rows.map((r) => r.map((c) => c ?? "-"))];
	const widths = headers.map((_, i) =>
		Math.max(...cells.map((r) => (r[i] ?? "").length)),
	);
	return cells
		.map((r) =>
			r
				.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

/** `quiet-otter-lamp (sb_…): ready` */
export function sandboxLine(sb: SandboxData): string {
	return `${sb.slug} (${sb.id}): ${sb.state}`;
}

/** The main fields of a sandbox, one per line. */
export function sandboxText(sb: SandboxData): string {
	const lines = [
		`${sb.slug} (${sb.id})`,
		`state: ${sb.state}${sb.health === "ok" ? "" : ` (${sb.health})`}`,
		`template: ${sb.template} ${sb.templateVersion ?? ""}`.trimEnd(),
		`size: ${sb.size} (${sb.vcpu} vCPU, ${sb.memoryMb} MB)`,
	];
	if (sb.name) lines.push(`name: ${sb.name}`);
	const labels = Object.entries(sb.labels ?? {});
	if (labels.length > 0) {
		lines.push(`labels: ${labels.map(([k, v]) => `${k}=${v}`).join(" ")}`);
	}
	if (sb.deadlineAt) lines.push(`deadline: ${sb.deadlineAt}`);
	if (sb.error) lines.push(`error: ${sb.error.code}: ${sb.error.message}`);
	if (sb.endpoints?.ssh) lines.push(`ssh: ${sb.endpoints.ssh}`);
	lines.push(`created: ${sb.createdAt}`);
	return lines.join("\n");
}

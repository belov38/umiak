// Links to the sandbox page (S8 §9.3): /app/t/<team>/sandboxes/<slug>,
// a tab as `?tab=` (Overview when absent).
import { teamPath } from "@/lib/team-path";

export type SandboxTab =
	| "terminal"
	| "commands"
	| "files"
	| "ports"
	| "ssh"
	| "env"
	| "desktop";

export function sandboxHref(
	teamId: string,
	slug: string,
	tab?: SandboxTab,
): string {
	const p = teamPath(teamId, `sandboxes/${encodeURIComponent(slug)}`);
	return tab === undefined ? p : `${p}?tab=${tab}`;
}

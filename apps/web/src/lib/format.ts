// Formatting shared by server and client renders: no locale or time zone
// of the machine, so the server HTML and the hydrated client agree.

/** `2026-10-31 14:05 UTC`, or "—". */
export function formatTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `6144 MB` → `6 GB` when whole. */
export function formatMb(mb: number): string {
	return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`; the UTC time after a week. */
export function formatAgo(iso: string | null | undefined, now: number): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	const s = Math.round((now - t) / 1000);
	if (s < 0) return formatTime(iso);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
	return formatTime(iso);
}

/** `2026-10-31` (UTC), or "—". */
export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

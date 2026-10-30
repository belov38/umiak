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

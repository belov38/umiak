/**
 * Splits an output budget between stdout and stderr: half each, and what the
 * shorter stream does not use goes to the longer one.
 */
export function splitBudget(
	max: number,
	sizes: { stdout: number; stderr: number },
): { stdout: number; stderr: number } {
	const half = Math.floor(max / 2);
	let stdout = Math.min(sizes.stdout, half);
	let stderr = Math.min(sizes.stderr, max - half);
	let spare = max - stdout - stderr;
	const moreOut = Math.min(spare, sizes.stdout - stdout);
	stdout += moreOut;
	spare -= moreOut;
	stderr += Math.min(spare, sizes.stderr - stderr);
	return { stdout, stderr };
}

/** The explicit "what was cut and how to read the rest" line; null if nothing was cut. */
export function truncationNote(
	stream: string,
	r: { from: number; to: number; size: number; mode: "tail" | "forward" },
): string | null {
	if (r.from <= 0 && r.to >= r.size) return null;
	const earlier = `Earlier output: exec_output with ${stream}_offset=0.`;
	const later = `Later output: exec_output with ${stream}_offset=${r.to}.`;
	if (r.mode === "tail" && r.to >= r.size) {
		return `${stream}: last ${r.to - r.from} of ${r.size} bytes. ${earlier}`;
	}
	const parts = [`${stream}: bytes ${r.from}–${r.to} of ${r.size}.`];
	if (r.from > 0) parts.push(earlier);
	if (r.to < r.size) parts.push(later);
	return parts.join(" ");
}

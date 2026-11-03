/** Positive artifact capability, shared by builders, adoption and bootstrap. */
export const DESKTOP_MARKER = "umiak-desktop";

/** Verify checks that prove a pre-marker Windows build has the desktop. */
export const DESKTOP_VERIFY_CHECKS = [
	"desktop_sunshine",
	"desktop_display",
	"desktop_agent_config",
] as const;

/**
 * Desktop evidence of a build manifest: the marker of new builds, or, for builds
 * made before the marker existed, a passed verify with every desktop check.
 */
export function hasDesktopEvidence(m: {
	desktopMarker?: string;
	verify?: { ok?: boolean; checks?: { id: string; status: string }[] } | null;
}): boolean {
	if (m.desktopMarker === DESKTOP_MARKER) return true;
	if (m.verify?.ok !== true) return false;
	return DESKTOP_VERIFY_CHECKS.every((id) =>
		m.verify?.checks?.some((c) => c.id === id && c.status === "PASS"),
	);
}

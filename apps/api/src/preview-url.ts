import type { Settings } from "./settings.ts";

export type PreviewSettings = Pick<Settings, "umiakDomain"> &
	Partial<Pick<Settings, "previewScheme" | "previewPort">>;

/** Public preview origin, including a non-default externally published port. */
export function previewUrl(label: string, settings: PreviewSettings): string {
	const scheme = settings.previewScheme ?? "https";
	const port = settings.previewPort ?? (scheme === "http" ? 80 : 443);
	const suffix = port === (scheme === "http" ? 80 : 443) ? "" : `:${port}`;
	return `${scheme}://${label}.${settings.umiakDomain}${suffix}`;
}

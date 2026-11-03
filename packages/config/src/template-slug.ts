/** Legacy Windows desktop inputs resolve to the single public Windows template. */
export function canonicalTemplateSlug(slug: string): string {
	return slug === "windows-desktop" ? "windows" : slug;
}

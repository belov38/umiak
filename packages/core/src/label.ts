import { isValidSlug } from "./slug.ts";

// Host label grammar (S4 §4.2): label = slug "-" port, port = [1-9][0-9]{0,4}
// in 1..65535. `<slug>-desktop` is the desktop host of a sandbox (S10 §10.1,
// the reserved suffix of S4 §4.2); routes for it come with S10.
const PORT_RE = /^[1-9][0-9]{0,4}$/;
const DESKTOP_SUFFIX = "desktop";

export type ParsedLabel =
	| { kind: "port"; slug: string; port: number }
	| { kind: "desktop"; slug: string };

/** Splits a host label into kind, slug and port; null if outside the grammar. */
export function parseLabel(label: string): ParsedLabel | null {
	const dash = label.lastIndexOf("-");
	if (dash <= 0) return null;
	const last = label.slice(dash + 1);
	const slug = label.slice(0, dash);
	if (!isValidSlug(slug)) return null;
	if (last === DESKTOP_SUFFIX) return { kind: "desktop", slug };
	if (!PORT_RE.test(last)) return null;
	const port = Number(last);
	if (port > 65535) return null;
	return { kind: "port", slug, port };
}

export function portLabel(slug: string, port: number): string {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new RangeError(`portLabel: invalid port ${port}`);
	}
	if (!isValidSlug(slug))
		throw new RangeError(`portLabel: invalid slug '${slug}'`);
	return `${slug}-${port}`;
}

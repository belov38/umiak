import { isValidSlug } from "./slug.ts";

// Host label grammar (S4 §4.2): label = slug "-" port, port = [1-9][0-9]{0,4} in 1..65535.
const PORT_RE = /^[1-9][0-9]{0,4}$/;

/** Splits a port host label into slug and port; null if outside the grammar. */
export function parseLabel(
	label: string,
): { slug: string; port: number } | null {
	const dash = label.lastIndexOf("-");
	if (dash <= 0) return null;
	const portStr = label.slice(dash + 1);
	if (!PORT_RE.test(portStr)) return null;
	const port = Number(portStr);
	if (port > 65535) return null;
	const slug = label.slice(0, dash);
	if (!isValidSlug(slug)) return null;
	return { slug, port };
}

export function portLabel(slug: string, port: number): string {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new RangeError(`portLabel: invalid port ${port}`);
	}
	if (!isValidSlug(slug))
		throw new RangeError(`portLabel: invalid slug '${slug}'`);
	return `${slug}-${port}`;
}

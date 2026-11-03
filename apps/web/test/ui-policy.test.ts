import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../src");
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
	);
}
/** Read opening tags without treating arrow functions or quoted > as tag ends. */
function openingTags(source: string): string[] {
	const tags: string[] = [];
	for (const match of source.matchAll(/<(?:a|Link)\b/g)) {
		let braces = 0,
			quote = "",
			tag = "";
		for (let i = match.index; i < source.length; i++) {
			const c = source[i] ?? "";
			tag += c;
			if (quote) {
				if (c === quote && source[i - 1] !== "\\") quote = "";
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				quote = c;
				continue;
			}
			if (c === "{") braces++;
			if (c === "}") braces--;
			if (c === ">" && braces === 0) {
				tags.push(tag);
				break;
			}
		}
	}
	return tags;
}
export function violations(source: string, path: string): string[] {
	const errors: string[] = [];
	const ui =
		path.startsWith("components/ui/") || path.endsWith("quickstart/ui.mjs");
	const renderer = path.includes("quickstart/");
	if (path.endsWith(".css")) {
		if (/\[data-slot(?:[=\]])/.test(source))
			errors.push("primitive CSS override");
		return errors;
	}
	if (!ui && !renderer) {
		for (const match of source.matchAll(/<(button|select|input|textarea)\b/g))
			errors.push(`raw ${match[1]}`);
		for (const tag of openingTags(source)) {
			if (
				/className/.test(tag) &&
				/(?:bg-|border(?:\s|["-])|rounded|px-\d|py-\d)/.test(tag)
			)
				errors.push("styled action link");
		}
	}
	// A colour must be CSS syntax or an arbitrary utility, never an anchor or prose.
	if (
		/(?:\[|:\s*)#[\da-fA-F]{3,8}\b|(?:color|backgroundColor|borderColor|fill|stroke)\s*:\s*["']#[\da-fA-F]{3,8}\b/i.test(
			source,
		)
	)
		errors.push("hex colour");
	if (!ui && /\brounded(?:-(?!none\b)[a-z0-9[\]_-]+)?(?=[\s"'`])/.test(source))
		errors.push("non-brand radius");
	if (
		/\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/.test(
			source,
		)
	)
		errors.push("palette colour");
	const arbitraryColours = Array.from(
		source.matchAll(
			/\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-\[([^\]]+)\]/g,
		),
	);
	if (
		arbitraryColours.some((m) => {
			const value = m[1] ?? "";
			return (
				/^(?:(?:color:)?(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(.*|color:(?!var\(|--)[^\s]+|[a-z]+)$/i.test(
					value,
				) && !/^(?:var|calc|url|min|max|clamp)\(/.test(value)
			);
		})
	)
		errors.push("arbitrary colour");
	if (/\bshadow(?:-(?!none\b)[\w[\]-]+)?(?=[\s"'`])/.test(source))
		errors.push("shadow");
	return errors;
}
test("UI policy rejects escapes, including multiline JSX", () => {
	expect(violations('<button\n type="button" />', "feature.tsx")).toContain(
		"raw button",
	);
	expect(violations('<input type="checkbox" />', "feature.tsx")).toContain(
		"raw input",
	);
	expect(
		violations('<a className="bg-primary px-4" />', "feature.tsx"),
	).toContain("styled action link");
	expect(
		violations('<div className="rounded-lg text-[#123456]" />', "feature.tsx"),
	).toEqual(["hex colour", "non-brand radius"]);
});
test("radius policy covers bare and directional radii", () => {
	for (const radius of [
		"rounded",
		"rounded-full",
		"rounded-t-lg",
		"rounded-[12px]",
	])
		expect(
			violations(`<div className="${radius}" />`, "feature.tsx"),
		).toContain("non-brand radius");
	expect(violations('<div className="rounded-none" />', "feature.tsx")).toEqual(
		[],
	);
});
test("all TSX uses shared primitives and brand tokens", () => {
	const errors = files(root)
		.filter((p) => p.endsWith(".tsx") || p.endsWith("globals.css"))
		.flatMap((p) =>
			violations(readFileSync(p, "utf8"), relative(root, p)).map(
				(e) => `${relative(root, p)}: ${e}`,
			),
		);
	expect(errors).toEqual([]);
});

test("policy catches template endings, palettes, arbitrary colours, shadows and callback links", () => {
	for (const source of [
		"<div className={`rounded-lg`} />",
		'<div className="bg-red-500" />',
		'<div className="text-[rgb(1,2,3)]" />',
		'<div className="shadow-lg" />',
		'<div className="shadow" />',
		'<div className="text-[red]" />',
		'<div className="text-[color:rebeccapurple]" />',
		'<div style={{color: "#abcdef"}} />',
		'<Link onClick={() => go()} className="bg-primary px-4" />',
	])
		expect(violations(source, "feature.tsx").length, source).toBeGreaterThan(0);
	expect(
		violations(
			'<a href="#abc">Ticket #123</a><p className="text-[10px]">#123</p>',
			"feature.tsx",
		),
	).toEqual([]);
	expect(
		violations('[data-slot="button"] { padding: 0 }', "globals.css"),
	).toContain("primitive CSS override");
});

test("focus primitives explicitly set a solid outline", () => {
	for (const name of ["button", "input", "select", "native-select", "textarea"])
		expect(
			readFileSync(join(root, `components/ui/${name}.tsx`), "utf8"),
		).toContain("focus-visible:outline-solid");
});

test("quickstart renderers use design tokens", () => {
	const base = join(root, "../../../deploy/compose/quickstart");
	for (const name of ["server.mjs", "setup-ui.mjs", "ui.mjs"])
		expect(
			violations(readFileSync(join(base, name), "utf8"), `quickstart/${name}`),
		).toEqual([]);
});

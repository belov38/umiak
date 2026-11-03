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
/** Read an expression, respecting nested delimiters and quoted template text. */
function expressionEnd(source: string, start: number): number {
	const stack: string[] = [];
	let quote = "";
	for (let i = start; i < source.length; i++) {
		const c = source[i] ?? "";
		if (quote) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === quote) {
				quote = "";
				if (!stack.length) return i + 1;
			}
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			continue;
		}
		if ("({[".includes(c)) stack.push(c);
		if (")}]".includes(c)) {
			stack.pop();
			if (!stack.length) return i + 1;
		}
		if (c === ";" && !stack.length) return i;
	}
	return source.length;
}
/** Follow class expressions and local bindings without scanning prose. */
function classContexts(source: string): string {
	const contexts: string[] = [];
	for (const match of source.matchAll(
		/\bclass(?:Name)?\s*=\s*|\b(?:cva|cn|clsx)\s*(?=\()/g,
	)) {
		const start = (match.index ?? 0) + match[0].length;
		contexts.push(source.slice(start, expressionEnd(source, start)));
	}
	const bindings = new Map<string, string[]>();
	for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*/g)) {
		const start = (match.index ?? 0) + match[0].length;
		const name = match[1] ?? "";
		bindings.set(name, [
			...(bindings.get(name) ?? []),
			source.slice(start, expressionEnd(source, start)),
		]);
	}
	const visited = new Set<string>();
	for (let i = 0; i < contexts.length; i++) {
		for (const match of (contexts[i] ?? "").matchAll(/\b\w+\b/g)) {
			const name = match[0];
			if (visited.has(name)) continue;
			visited.add(name);
			contexts.push(...(bindings.get(name) ?? []));
		}
	}
	return contexts.join(" ");
}
export function violations(source: string, path: string): string[] {
	const errors: string[] = [];
	const ui =
		path.startsWith("components/ui/") || path.endsWith("quickstart/ui.mjs");
	const renderer = path.includes("quickstart/");
	const slot = /\[\s*data-slot\s*(?:[~|^$*]?=|\])/;
	if (path.endsWith(".css")) {
		if (slot.test(source)) errors.push("primitive CSS override");
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
	const classes = classContexts(source);
	const styles = [
		...source.matchAll(/\bstyle\s*=\s*(?:\{\{[\s\S]*?\}\}|"[^"]*"|'[^']*')/g),
	]
		.map((m) => m[0])
		.join(" ");
	// Quickstart owns its CSS primitives, but shares the utility and token policy.
	const css = renderer
		? [
				...source.matchAll(
					/<style[^>]*>([\s\S]*?)<\/style>|const style = `([\s\S]*?)`/g,
				),
			]
				.map((m) => m[1] ?? m[2])
				.join(" ")
		: "";
	if (renderer && /(?:box|text)-shadow\s*:\s*(?!none\b)[^;}]+/.test(css))
		errors.push("shadow");
	if (
		renderer &&
		/border(?:-[\w-]+)?-radius\s*:\s*(?!0(?:[a-z%]+)?\s*(?:;|}))/.test(css)
	)
		errors.push("non-brand radius");
	if (renderer) {
		for (const declaration of css.matchAll(
			/(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|color))?)\s*:\s*([^;}]+)/g,
		)) {
			const value = (declaration[1] ?? "")
				.replace(/var\([^)]*\)/g, "")
				.replace(
					/\b(?:transparent|currentColor|inherit|initial|unset|none|solid|dashed|dotted|important)\b/gi,
					"",
				)
				.replace(/[\d.]+(?:px|rem|em|%)?/g, "")
				.replace(/[\s!]/g, "");
			if (value) {
				errors.push("CSS colour outside tokens");
				break;
			}
		}
	}

	if (slot.test(classes) || slot.test(css))
		errors.push("primitive CSS override");
	if (
		/#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/i.test(
			classes + styles + css,
		)
	)
		errors.push("hex colour");
	if (!ui && /\brounded(?:-(?!none\b)[^\s"'`]+)?(?=[\s"'`]|$)/.test(classes))
		errors.push("non-brand radius");
	if (
		!ui &&
		/(?:\b(?:color|background\w*|border\w*|(?:box|text)Shadow|fill|stroke)\s*:|(?:background|border|box-shadow|text-shadow|color)\s*:)/i.test(
			styles,
		)
	)
		errors.push("inline presentation style");
	if (
		/\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/.test(
			classes,
		)
	)
		errors.push("palette colour");
	if (
		[
			...classes.matchAll(
				/\b(?:bg|text|border|outline|ring|fill|stroke|from|via|to)-\[([^\]]+)\]/g,
			),
		].some(
			(m) =>
				/^(?:(?:color:)?(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(|color:(?!var\(|--)|[a-z]+$)/i.test(
					m[1] ?? "",
				) && !/^(?:var|calc|url|min|max|clamp)\(/.test(m[1] ?? ""),
		)
	)
		errors.push("arbitrary colour");
	if (
		/(?:^|[\s:!"'`])(?:[\w-]*:)*shadow(?:-(?!none\b)[^\s"'`]+)?(?=[\s"'`]|$)/.test(
			classes,
		)
	)
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
		.filter((p) => p.endsWith(".tsx") || p.endsWith(".css"))
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

test("acceptance fixtures close policy gaps in every renderer", () => {
	for (const path of [
		"feature.tsx",
		"quickstart/server.mjs",
		"quickstart/setup-ui.mjs",
		"quickstart/ui.mjs",
	]) {
		for (const cls of [
			"[&_[data-slot=button]]:px-8",
			"hover:shadow-[0_1px_2px_red]",
			"dark:hover:shadow-lg",
			"bg-black",
			"text-white",
		]) {
			expect(
				violations(`<div className="${cls}" />`, path).length,
				`${path}: ${cls}`,
			).toBeGreaterThan(0);
		}
		if (!path.endsWith("/ui.mjs")) {
			for (const source of [
				'<div style={{ background: "#ff0000" }} />',
				'<div style={{ color: "red" }} />',
				"<div style={{ border: border }} />",
				"<div style={{ boxShadow: shadow }} />",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: regression source fixture
				"<div className={`rounded-${x}`} />",
			])
				expect(violations(source, path).length, source).toBeGreaterThan(0);
		}
		expect(
			violations(
				'<p>Build: #123</p><p>shadow copy</p><a href="#abc">Link</a>',
				path,
			),
		).toEqual([]);
	}
	for (const selector of [
		"[data-slot~=button]",
		'[data-slot^="button"]',
		'[data-slot *= "button"]',
		"[data-slot$=button]",
		"[data-slot|=button]",
	])
		expect(violations(`${selector} { padding: 0 }`, "feature.css")).toContain(
			"primitive CSS override",
		);
});

test.each(["server.mjs", "setup-ui.mjs", "ui.mjs"])(
	"quickstart CSS policy: %s",
	(name) => {
		for (const css of [
			".x{box-shadow:0 1px red}",
			".x{border-radius:12px}",
			".x{border-radius:var(--radius)}",
			".x{color:white}",
			".x{background:rgb(1,2,3)}",
			".x{color:#123456}",
			"[data-slot *= button]{padding:0}",
		])
			expect(
				violations(`<style>${css}</style>`, `quickstart/${name}`).length,
				css,
			).toBeGreaterThan(0);
	},
);

test.each([
	['const classes = "bg-black"; <div className={classes} />', "palette colour"],
	[
		'const variant = "text-[#abcdef]"; const classes = cn(variant); <div className={classes} />',
		"hex colour",
	],
	[
		'const buttonVariants = cva("shadow-lg", {variants:{variant:{default:"bg-black"}}});',
		"shadow",
	],
	[
		// biome-ignore lint/suspicious/noTemplateCurlyInString: regression source fixture
		"const classes = `rounded-${size}`; <div className={classes} />",
		"non-brand radius",
	],
])("policy follows class bindings: %s", (source, expected) => {
	expect(
		violations(source, "components/ui/button.tsx").concat(
			violations(source, "feature.tsx"),
		),
	).toContain(expected);
});

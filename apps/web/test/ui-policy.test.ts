import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../src");
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
	);
}
export function violations(source: string, path: string): string[] {
	const errors: string[] = [];
	const ui = path.startsWith("components/ui/");
	if (!ui) {
		for (const match of source.matchAll(/<(button|select|input|textarea)\b/g))
			errors.push(`raw ${match[1]}`);
		for (const match of source.matchAll(/<(?:a|Link)\b[\s\S]*?>/g)) {
			if (
				/className/.test(match[0]) &&
				/(?:bg-|border(?:\s|["-])|rounded|px-\d|py-\d)/.test(match[0])
			)
				errors.push("styled action link");
		}
	}
	if (/#[\da-fA-F]{3,8}\b/.test(source)) errors.push("hex colour");
	if (!ui && /\brounded(?:-(?!none\b)[a-z0-9[\]_-]+)?(?=[\s"'])/.test(source))
		errors.push("non-brand radius");
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
		.filter((p) => p.endsWith(".tsx"))
		.flatMap((p) =>
			violations(readFileSync(p, "utf8"), relative(root, p)).map(
				(e) => `${relative(root, p)}: ${e}`,
			),
		);
	expect(errors).toEqual([]);
});

#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRecipe, loadVersions } from "./recipe.ts";
import { formatVersionsToml, updateVersionsFile } from "./versions-update.ts";

const USAGE = `usage:
  sbx-tpl versions <slug> [--update]`;

const TEMPLATES_DIR = resolve(import.meta.dirname, "../../../infra/templates");

async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { update: { type: "boolean", default: false } },
	});
	const [cmd, slug] = positionals;
	if (cmd !== "versions" || !slug || positionals.length > 2) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	if (values.update) {
		const { file, changes } = await updateVersionsFile({
			templatesDir: TEMPLATES_DIR,
			slug,
		});
		process.stdout.write(
			`${file}\n${changes.length > 0 ? changes.join("\n") : "no changes"}\n`,
		);
	} else {
		const versions = loadVersions(loadRecipe(TEMPLATES_DIR, slug));
		process.stdout.write(formatVersionsToml(versions));
	}
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	},
);

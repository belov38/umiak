import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

let world: CliWorld;
let home: CliHome;
let ref: string;
beforeAll(async () => {
	world = await startWorld();
	home = cliHome();
	ref = (await world.readySandbox()).slug;
	const base = world.deps.config;
	world.deps.config = new Proxy(base, {
		get(t, k) {
			if (k === "template")
				return async (slug: string) => {
					const template = await t.template(slug);
					return template
						? {
								...template,
								capabilities: [...template.capabilities, "desktop"],
							}
						: null;
				};
			const value = Reflect.get(t, k);
			return typeof value === "function" ? value.bind(t) : value;
		},
	});
});
afterAll(async () => {
	await world?.close();
	home?.rm();
});
it("desktop URL, clipboard, screenshot and JSON input reach the public API", async () => {
	const env = {
		...home.env,
		SBX_API_URL: world.url,
		SBX_API_KEY: world.secret,
	};
	const cli = (args: string[]) => runCli(args, { env });
	const link = await cli(["desktop", ref, "--json"]);
	expect(link.code, link.stderr).toBe(0);
	expect(link.last()).toMatchObject({
		url: expect.stringContaining("?_ticket=sbxd_"),
	});
	expect((await cli(["clipboard", ref, "--text", "CLI текст"])).code).toBe(0);
	const clip = await cli(["clipboard", ref, "--json"]);
	expect(clip.last()).toMatchObject({ text: "CLI текст" });
	const image = join(home.dir, "screen.png");
	const shot = await cli(["screenshot", ref, "--output", image]);
	expect(shot.code, shot.stderr).toBe(0);
	expect((await readFile(image)).subarray(1, 4).toString()).toBe("PNG");
	const file = join(home.dir, "input.json");
	await writeFile(
		file,
		JSON.stringify({ actions: [{ type: "move", x: 10, y: 20 }] }),
	);
	const result = await cli(["input", ref, "--file", file, "--json"]);
	expect(result.code, result.stderr).toBe(0);
	expect(result.last()).toMatchObject({ completed: 1 });
});

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

it("sbx desktop subcommands follow S10 14.2", async () => {
	const env = {
		...home.env,
		SBX_API_URL: world.url,
		SBX_API_KEY: world.secret,
	};
	const cli = (args: string[], input?: string) =>
		runCli(args, { env, ...(input === undefined ? {} : { stdin: input }) });
	const link = await cli([
		"desktop",
		ref,
		"--print",
		"--fps",
		"60",
		"--transport",
		"websocket",
		"--json",
	]);
	expect(link.code, link.stderr).toBe(0);
	const url = new URL((link.last() as { url: string }).url);
	expect(url.searchParams.get("fps")).toBe("60");
	expect(url.searchParams.get("dataTransport")).toBe("websocket");
	expect((await cli(["desktop", "open", ref, "--print"])).code).toBe(0);

	const image = join(home.dir, "desk.jpg");
	const shot = await cli([
		"desktop",
		"screenshot",
		ref,
		"-o",
		image,
		"--jpeg",
		"--max-width",
		"640",
		"--json",
	]);
	expect(shot.code, shot.stderr).toBe(0);
	// The fake guest ignores scaling; the options reach it as query parameters.
	expect(shot.last()).toMatchObject({ path: image, screen: { width: 1920 } });
	expect((await readFile(image)).length).toBeGreaterThan(0);

	for (const form of [
		["click", "10", "20"],
		["type", "hello", "мир"],
		["key", "ctrl+c"],
		["scroll", "3"],
	]) {
		const r = await cli(["desktop", "act", ref, ...form, "--json"]);
		expect(r.code, `${form[0]}: ${r.stderr}`).toBe(0);
		expect(r.last()).toMatchObject({ completed: 1 });
	}
	const piped = await cli(
		["desktop", "act", ref, "--file", "-"],
		JSON.stringify({ actions: [{ type: "move", x: 1, y: 2 }] }),
	);
	expect(piped.code, piped.stderr).toBe(0);
	expect((await cli(["desktop", "act", ref, "jump"])).code).not.toBe(0);

	expect(
		(await cli(["desktop", "clipboard", ref, "set", "CLI", "буфер"])).code,
	).toBe(0);
	expect(
		(await cli(["desktop", "clipboard", ref, "--json"])).last(),
	).toMatchObject({ text: "CLI буфер" });
	expect(
		(await cli(["desktop", "access", ref, "sso", "--json"])).last(),
	).toMatchObject({ access: "sso" });
	expect((await cli(["desktop", "end-streams", ref])).code).toBe(0);
	const help = await cli(["--help"]);
	expect(help.stdout).not.toMatch(/^\s+screenshot/m);
});

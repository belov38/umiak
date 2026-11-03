import assert from "node:assert/strict";
import test from "node:test";
import { windowsDesktop } from "./setup-desktop.mjs";

test("fresh DB artifact detection fails closed and accepts positive desktop tags", async () => {
	assert.equal(
		await windowsDesktop(
			{ tags: "umiak-tpl", name: "umiak-tpl-windows-20261101-2" },
			"pve",
			600,
			"/nonexistent",
		),
		false,
	);
	assert.equal(
		await windowsDesktop(
			{ tags: "umiak-tpl;umiak-desktop" },
			"pve",
			601,
			"/nonexistent",
		),
		true,
	);
});

test("stand manifest evidence recognises 595 but never 598 or a mismatched artifact", async (t) => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "umiak-marker-"));
	t.after(() => rm(dir, { recursive: true }));
	const id = "01a1993d-3986-7c3e-ab41-4408207656c4";
	const config = {
		name: "umiak-tpl-windows-desktop-20261101-7",
		tags: "umiak-tpl",
		description: `umiak-tpl build ${id}\ngit test`,
	};
	const m = {
		buildId: id,
		node: "pve",
		pveVmid: 595,
		vmName: config.name,
		os: "windows",
		status: "ready",
		verify: {
			ok: true,
			checks: [
				"desktop_sunshine",
				"desktop_display",
				"desktop_agent_config",
			].map((id) => ({ id, status: "PASS" })),
		},
	};
	await writeFile(join(dir, `${id}.json`), JSON.stringify(m));
	assert.equal(await windowsDesktop(config, "pve", 595, dir), true);
	assert.equal(await windowsDesktop(config, "pve", 598, dir), false);
	assert.equal(
		await windowsDesktop({ ...config, name: "other" }, "pve", 595, dir),
		false,
	);
	m.verify.checks[0].status = "FAIL";
	await writeFile(join(dir, `${id}.json`), JSON.stringify(m));
	assert.equal(await windowsDesktop(config, "pve", 595, dir), false);
});

test("fresh DB wizard offers only desktop and refuses legacy registration", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const state = {
		steps: Object.fromEntries(
			["connection", "host", "limits", "network"].map((key) => [
				key,
				{
					status: "ready",
					data:
						key === "connection"
							? { node: "pve" }
							: key === "limits"
								? { nodeId: "node", vmidMin: 500, vmidMax: 589 }
								: {},
				},
			]),
		),
	};
	const vms = [
		{
			vmid: 600,
			name: "umiak-tpl-windows-legacy",
			template: 1,
			tags: "umiak-tpl",
		},
		{
			vmid: 601,
			name: "umiak-tpl-windows-desktop",
			template: 1,
			tags: "umiak-tpl;umiak-desktop",
		},
	];
	const handler = createSetupHandler({
		store: { read: async () => state, write: async () => {} },
		pool: { query: async () => ({ rows: [] }) },
		makePve: () => ({
			get: async (path) =>
				path.endsWith("/qemu")
					? vms
					: vms.find((v) => path.includes(`/${v.vmid}/`)),
		}),
	});
	let html;
	await handler(
		{ url: "/setup", method: "GET" },
		{
			writeHead() {},
			end(value) {
				html = value;
			},
		},
		{ origin: "http://localhost", owner: true },
	);
	assert.deepEqual(
		state.detectedTemplates.map((v) => v.pveVmid),
		[601],
	);
	assert.match(html, /umiak-tpl-windows-desktop/);
	await assert.rejects(
		handler.wizard.run("templates", {
			builds: [
				{ templateSlug: "windows", pveVmid: 600 },
				{ templateSlug: "linux", pveVmid: 602 },
			],
		}),
		/legacy headless/,
	);
});

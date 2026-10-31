// Dev-only S10 verifier: inspect qm list before EVERY clone start, sharing 8GiB with S9.

import { resolve } from "node:path";
import {
	machinesFor,
	makeContext,
	RamGuard,
	registryDir,
} from "../../apps/template-builder/src/context.ts";
import { loadVerifyScript } from "../../apps/template-builder/src/recipe.ts";
import { FileRegistry } from "../../apps/template-builder/src/registry.ts";
import { pveGuestIo } from "../../apps/template-builder/src/runner.ts";
import {
	defaultSecretFiles,
	verifyTemplate,
} from "../../apps/template-builder/src/verify.ts";
import { waitForDesktopBudget } from "./desktop-budget.ts";

const registry = new FileRegistry(registryDir());
const manifest = registry.get(process.argv[2] ?? "");
if (
	manifest?.templateSlug !== "linux-desktop" ||
	![595, 596].includes(manifest.pveVmid ?? 0)
)
	throw new Error("expected a linux-desktop build in 595/596");
const ctx = await makeContext({ node: manifest.node });
const real = machinesFor(ctx, manifest.pveVmid as number);
const machines = new Proxy(real, {
	get(target, prop) {
		if (prop === "start")
			return async (vmid: number) => {
				if (vmid < 500 || vmid > 589)
					throw new Error("verify sandbox outside 500–589");
				await waitForDesktopBudget();
				return target.start(vmid);
			};
		const value = Reflect.get(target, prop, target);
		return typeof value === "function" ? value.bind(target) : value;
	},
});
try {
	const result = await verifyTemplate(
		{
			machines,
			io: (vmid) => pveGuestIo(ctx.api, ctx.cfg.node, vmid),
			node: ctx.node,
			ramGuard: new RamGuard({
				api: ctx.api,
				node: ctx.cfg.node,
				pool: ctx.cfg.pool,
				capMb: 8192,
			}),
			verifyScript: loadVerifyScript(
				resolve(import.meta.dirname, "../templates"),
				"linux-desktop",
			),
			secretFiles: defaultSecretFiles(ctx.cfg),
			log: console.log,
		},
		manifest,
	);
	registry.update(manifest.buildId, { verify: result });
	console.log(result.ok ? "verify: ok" : "verify: FAILED");
	process.exitCode = result.ok ? 0 : 1;
} finally {
	ctx.close();
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("publishes only manually behind the reviewed SHA gate, with file-only secrets and no vendor/stand path", () => {
	const source = readFileSync(
		resolve(import.meta.dirname, "../../../.github/workflows/linux-layers.yml"),
		"utf8",
	);
	const workflow = parse(source);
	expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
	expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
	expect(workflow.jobs.layers.permissions.packages).toBe("write");
	expect(workflow.jobs.layers.env).not.toHaveProperty("GITHUB_TOKEN");
	expect(workflow.jobs.layers.env).not.toHaveProperty("RECIPE_SIGNING_KEY");
	expect(source).not.toMatch(
		/R2_|r2\.dev|192\.168\.68\.116|self-hosted|pvesh|qm create/,
	);
	const steps = workflow.jobs.layers.steps;
	expect(
		steps.find((s: { name?: string }) => s.name?.startsWith("Upload immutable"))
			.if,
	).toContain("inputs.publish");
	expect(
		steps.findIndex((s: { name?: string }) =>
			s.name?.startsWith("Materialize recipe key"),
		),
	).toBeGreaterThan(
		steps.findIndex((s: { name?: string }) =>
			s.name?.startsWith("Capture inputs"),
		),
	);
	expect(source).toContain("toJSON(secrets.RECIPE_SIGNING_KEY)");
	expect(source).toContain("toJSON(github.token)");
	const build = readFileSync(
		resolve(import.meta.dirname, "../../../infra/templates/build-layers.mjs"),
		"utf8",
	);
	expect(build).not.toContain("installVendorTools");
	expect(build).toContain("replayLayer");
});

it("signs staged artifacts without running KVM and verifies them before loading the signing key", () => {
	const workflow = parse(
		readFileSync(
			resolve(
				import.meta.dirname,
				"../../../.github/workflows/linux-layers.yml",
			),
			"utf8",
		),
	);
	expect(workflow.on.workflow_dispatch.inputs.action.options).toContain(
		"sign-staged",
	);
	const steps = workflow.jobs.layers.steps;
	const fetch = steps.findIndex((s: { name?: string }) =>
		s.name?.startsWith("Pull staged"),
	);
	const key = steps.findIndex((s: { name?: string }) =>
		s.name?.startsWith("Materialize recipe key"),
	);
	expect(fetch).toBeGreaterThan(-1);
	expect(key).toBeGreaterThan(fetch);
	expect(steps[fetch].run).toContain("verify-staged");
	for (const prefix of [
		"Install local QEMU",
		"Probe actual KVM",
		"Build the generic agent",
		"Capture inputs",
	]) {
		expect(
			steps.find((s: { name?: string }) => s.name?.startsWith(prefix)).if,
		).toBe("inputs.action == 'build'");
	}
});

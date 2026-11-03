import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type GuideDeployment,
	guideSections,
} from "../src/features/getting-started/content.ts";

const deployment: GuideDeployment = {
	mode: "owner",
	apiUrl: "https://api.example.com",
	appUrl: "https://app.example.com",
	previewDomain: "preview.example.com",
};
describe("Getting started", () => {
	it("uses this deployment's URLs and owner CA installer", () => {
		const text = JSON.stringify(guideSections(deployment));
		expect(text).toContain("https://api.example.com/install.sh");
		expect(text).toContain("--cacert");
		expect(text).toContain("https://app.example.com/mcp");
		expect(text).not.toContain("192.168.68.90");
	});
	it("uses build-from-source and mode-specific authentication outside quickstart", () => {
		for (const mode of ["none", "oidc"] as const) {
			const text = JSON.stringify(guideSections({ ...deployment, mode }));
			expect(text).toContain("pnpm --filter @umiak/cli build");
			expect(text).not.toContain("install.sh");
			expect(text).toContain(
				mode === "none" ? "No sign-in" : "browser sign-in",
			);
		}
	});
	it("uses the trusted Serve origin without private CA flags", () => {
		const text = JSON.stringify(
			guideSections({ ...deployment, ownerPrivateCA: false }),
		);
		expect(text).toContain("https://api.example.com/install.sh");
		expect(text).not.toContain("--cacert");
		expect(text).not.toContain("UMIAK_CA_CERT");
		expect(text).toContain("compose.tailscale.yaml");
	});

	it("keeps every guide command in the checked-in documentation", () => {
		const docs = readFileSync(
			new URL("../../../docs/getting-started.md", import.meta.url),
			"utf8",
		);
		for (const mode of ["owner", "none", "oidc"] as const) {
			for (const section of [true, false].flatMap((ownerPrivateCA) =>
				guideSections({ ...deployment, mode, ownerPrivateCA }),
			)) {
				for (const block of section.blocks) {
					if (block.kind === "code")
						expect(docs, `${mode}: ${block.label}`).toContain(block.text);
				}
			}
		}
	});
});

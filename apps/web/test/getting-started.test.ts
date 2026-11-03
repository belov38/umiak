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
	it("uses this deployment's URLs without an owner CA installer", () => {
		const text = JSON.stringify(guideSections(deployment));
		expect(text).toContain("https://api.example.com/install.sh");
		expect(text).not.toContain("--cacert");
		expect(text).not.toContain("owner/tls");
		expect(text).not.toContain("UMIAK_CA_CERT");
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
	it("supports the default LAN HTTP origin and optional HTTPS", () => {
		const text = JSON.stringify(
			guideSections({ ...deployment, apiUrl: "http://192.168.1.20:8080" }),
		);
		expect(text).toContain("http://192.168.1.20:8080/install.sh");
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
			for (const section of guideSections({ ...deployment, mode })) {
				for (const block of section.blocks) {
					if (block.kind === "code")
						expect(docs, `${mode}: ${block.label}`).toContain(block.text);
				}
			}
		}
	});
});

it("uses metadata preview scheme and nondefault port in the published URL", () => {
	const text = JSON.stringify(
		guideSections({ ...deployment, previewScheme: "http", previewPort: 8085 }),
	);
	expect(text).toContain("http://<slug>-<port>.preview.example.com:8085");
	expect(
		JSON.stringify(
			guideSections({
				...deployment,
				previewScheme: "https",
				previewPort: 443,
			}),
		),
	).toContain("https://<slug>-<port>.preview.example.com");
	expect(
		JSON.stringify(
			guideSections({
				...deployment,
				previewScheme: "https",
				previewPort: 443,
			}),
		),
	).not.toContain("preview.example.com:443");
});

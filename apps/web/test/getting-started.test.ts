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
		const text = JSON.stringify(guideSections({ ...deployment, mode: "oidc" }));
		expect(text).toContain("pnpm --filter @umiak/cli build");
		expect(text).not.toContain("install.sh");
		expect(text).toContain("browser sign-in");
	});
	it("describes tailnet HTTPS access without LAN HTTP or the Compose sidecar", () => {
		const text = JSON.stringify(guideSections(deployment));
		expect(text).toContain("tailnet HTTPS address");
		for (const legacy of [
			"LAN HTTP",
			"trusted LAN",
			"plain HTTP on your",
			"compose.tailscale.yaml",
			"TS_AUTHKEY",
			"chrome://flags",
			"Funnel",
		])
			expect(text).not.toContain(legacy);
	});

	it("keeps every guide command in the checked-in documentation", () => {
		const docs = readFileSync(
			new URL("../../../docs/getting-started.md", import.meta.url),
			"utf8",
		);
		for (const mode of ["owner", "oidc"] as const) {
			for (const section of guideSections({ ...deployment, mode })) {
				for (const block of section.blocks) {
					if (block.kind === "code")
						expect(docs, `${mode}: ${block.label}`).toContain(block.text);
				}
			}
		}
	});
});

it("describes quickstart HTTP previews as tailnet-only", () => {
	const text = JSON.stringify(
		guideSections({ ...deployment, previewScheme: "http", previewPort: 8085 }),
	);
	expect(text).toContain("tailnet IP");
	expect(text).toContain("reachable only from your tailnet");
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

import { QueryClientProvider } from "@tanstack/react-query";
import type { Sandbox, SandboxData } from "@umiak/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OwnerModeContext } from "../src/components/app/session-context";
import { DesktopTab } from "../src/features/sandbox/desktop";
import { makeQueryClient } from "../src/lib/api";

const sandbox = {
	id: "sbx_test",
	state: "ready",
	blocked: false,
} as unknown as SandboxData;
const handle = { desktop: {} } as unknown as Sandbox;

function render(ownerMode: boolean) {
	return renderToStaticMarkup(
		<OwnerModeContext.Provider value={ownerMode}>
			<QueryClientProvider client={makeQueryClient()}>
				<DesktopTab sandbox={sandbox} handle={handle} track={() => {}} />
			</QueryClientProvider>
		</OwnerModeContext.Provider>,
	);
}

// The owner ingress viewer (/desktop/<slug>/) is owner-session gated and uses its
// own gateway credential, so access mode and stream revocation do not apply to it.
it("hides desktop access and disconnect controls in owner mode", () => {
	const html = render(true);
	expect(html).toContain("Open in new tab");
	expect(html).not.toContain("Desktop access");
	expect(html).not.toContain("Secret link");
	expect(html).not.toContain("Public");
	expect(html).not.toContain("Disconnect all viewers");
});

it("keeps desktop access and disconnect controls in team mode", () => {
	const html = render(false);
	expect(html).toContain("Desktop access");
	expect(html).toContain("Secret link");
	expect(html).toContain("Team members");
	expect(html).toContain("Disconnect all viewers");
});

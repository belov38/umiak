import { QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@umiak/sdk";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SessionProvider } from "../src/components/app/session-context";
import { CreateSandboxForm } from "../src/features/create/create-form";
import { makeQueryClient, UmiakProvider } from "../src/lib/api";

vi.mock("@/lib/navigation", () => ({
	useAppNavigation: () => ({ go: vi.fn() }),
}));
vi.mock("@/features/sandboxes/sandbox-list", () => ({
	SandboxList: () => null,
}));
vi.mock("@/components/ui/dialog", () => {
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	);
	return {
		Dialog: Wrapper,
		DialogContent: Wrapper,
		DialogHeader: Wrapper,
		DialogTitle: Wrapper,
		DialogDescription: Wrapper,
	};
});
const template = (
	slug: string,
	version: string | null,
): components["schemas"]["Template"] => ({
	slug,
	version,
	name: slug,
	os: "linux",
	capabilities: ["exec"],
	defaultSize: "2gb",
	allowedSizes: ["2gb"],
	enabled: true,
	loginUser: "user",
	buildCreatedAt: null,
	pveVmid: null,
});
function render(templates: components["schemas"]["Template"][]) {
	const client = makeQueryClient();
	client.setQueryData(["templates", "team_test"], templates);
	client.setQueryData(["snapshots", "team_test"], []);
	const html = renderToStaticMarkup(
		<SessionProvider
			session={{
				user: { id: "usr_test", name: "Owner", email: "owner@example.com" },
				teams: [],
				defaultTeamId: "team_test",
				isOperator: false,
			}}
		>
			<UmiakProvider>
				<QueryClientProvider client={client}>
					<CreateSandboxForm teamId="team_test" prefill={{}} />
				</QueryClientProvider>
			</UmiakProvider>
		</SessionProvider>,
	);
	client.clear();
	return html;
}
it.each([[], [template("linux", null)]])(
	"replaces creation with setup when no built template exists (%j)",
	(...templates) => {
		const html = render(templates as components["schemas"]["Template"][]);
		expect(html).toContain(
			"Build a Linux template before creating your first sandbox",
		);
		expect(html).toContain('href="/setup"');
		expect(html).not.toContain('data-testid="create-form"');
	},
);
it("disables unbuilt choices and collapses advanced fields when another template is usable", () => {
	const html = render([
		template("linux", "v1"),
		template("linux-desktop", null),
	]);
	expect(html).toContain("Build this template first");
	expect(html).toMatch(/<input[^>]*disabled=""/);
	expect(html).toMatch(/<details[^>]*><summary[^>]*>Advanced settings/);
	expect(html).toContain("Create sandbox");
	expect(html).not.toContain("no active build");
});

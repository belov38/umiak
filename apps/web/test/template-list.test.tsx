import { QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@umiak/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SessionProvider } from "../src/components/app/session-context";
import { TemplateList } from "../src/features/templates/template-list";
import { makeQueryClient, UmiakProvider } from "../src/lib/api";
import type { AppSession } from "../src/lib/app-session";

// Server actions require a request context; this read-only render never calls one.
vi.mock("@/actions/templates", () => ({ setTemplateEnabled: vi.fn() }));

const session: AppSession = {
	user: { id: "usr_test", name: "Test member", email: "member@example.com" },
	teams: [
		{ id: "team_test", name: "Test team", role: "member", personal: false },
	],
	defaultTeamId: "team_test",
	isOperator: false,
};

it.each([
	{ name: "Windows Server 2025", heading: "Windows Server 2025" },
	{ name: "", heading: "windows" },
])(
	"renders the catalog Windows name '$name' with a slug fallback",
	({ name, heading }) => {
		const template: components["schemas"]["Template"] = {
			slug: "windows",
			name,
			os: "windows",
			capabilities: ["exec", "files", "ssh", "desktop"],
			defaultSize: "4gb",
			allowedSizes: ["4gb"],
			enabled: true,
			loginUser: "user",
			version: "v1",
			buildCreatedAt: null,
			pveVmid: null,
		};
		const client = makeQueryClient();
		client.setQueryData(["templates", "team_test"], [template]);
		const html = renderToStaticMarkup(
			<SessionProvider session={session}>
				<UmiakProvider>
					<QueryClientProvider client={client}>
						<TemplateList teamId="team_test" quickstart={false} />
					</QueryClientProvider>
				</UmiakProvider>
			</SessionProvider>,
		);
		const headings = [...html.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/g)].map(
			(match) => match[1],
		);
		expect(headings).toContain(heading);
		client.clear();
	},
);

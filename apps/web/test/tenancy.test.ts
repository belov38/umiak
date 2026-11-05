import { describe, expect, it } from "vitest";
import { guideSections } from "../src/features/getting-started/content.ts";
import { metaTenancy } from "../src/lib/tenancy.ts";

describe("explicit metadata tenancy", () => {
	it("defaults absent and unknown values to teams for old deployments", () => {
		for (const meta of [
			undefined,
			{},
			{ authMode: "owner" },
			{ tenancy: "unknown" },
			{ tenancy: "teams" },
		])
			expect(metaTenancy(meta)).toBe("teams");
	});
	it("accepts only the explicit single field irrespective of auth mode", () => {
		expect(metaTenancy({ tenancy: "single", authMode: "owner" })).toBe(
			"single",
		);
	});
	it("does not teach team concepts in single-owner Getting started", () => {
		for (const mode of ["owner"] as const) {
			const sections = guideSections({
				mode,
				tenancy: "single",
				apiUrl: "https://api.example.com",
				appUrl: "https://app.example.com",
				previewDomain: "preview.example.com",
			});
			expect(JSON.stringify(sections)).not.toMatch(
				/\bteams?\b|\bmembers?\b|\binvit(?:e|es)\b/i,
			);
		}
	});
	it("retains teams for an explicit teams presentation", () => {
		expect(
			JSON.stringify(
				guideSections({
					mode: "owner",
					tenancy: "teams",
					apiUrl: "https://api.example.com",
					appUrl: "https://app.example.com",
					previewDomain: "preview.example.com",
				}),
			),
		).toContain("Your team owns");
	});
});

import { UmiakError } from "@umiak/sdk";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { AppShell } from "../src/components/app/app-shell.tsx";
import { SessionProvider } from "../src/components/app/session-context.tsx";
import { KeysPage } from "../src/features/keys/keys-page.tsx";
import { UmiakProvider } from "../src/lib/api.ts";
import type { AppSession } from "../src/lib/app-session.ts";
import { describeError } from "../src/lib/errors.ts";

vi.mock("@/lib/navigation", () => ({ usePathname: () => "/app" }));
const session: AppSession = {
	user: { id: "usr_local", name: "Local owner", email: "local@umiak.local" },
	teams: [
		{ id: "team_local", name: "Local team", role: "owner", personal: true },
	],
	defaultTeamId: "team_local",
	isOperator: true,
};
function markup(
	tenancy: "single" | "teams",
	child: ReactNode = createElement("h1", null, "Sandboxes"),
	quickstart = false,
) {
	return renderToStaticMarkup(
		createElement(SessionProvider, {
			session,
			tenancy,
			// biome-ignore lint/correctness/noChildrenProp: Component props require children when using createElement in a .ts test.
			children: createElement(UmiakProvider, {
				// biome-ignore lint/correctness/noChildrenProp: Component props require children when using createElement in a .ts test.
				children: createElement(AppShell, {
					team: {
						id: "team_local",
						name: "Local team",
						role: "owner",
						personal: true,
					},
					member: true,
					ownerMode: true,
					quickstart,
					// biome-ignore lint/correctness/noChildrenProp: Component props require children when using createElement in a .ts test.
					children: child,
				}),
			}),
		}),
	);
}
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ");
describe("single-owner dashboard", () => {
	it("has one navigation without account, operator or team controls in local and owner modes", () => {
		for (const quickstart of [true, false]) {
			const html = markup("single", undefined, quickstart);
			expect(visibleText(html)).not.toMatch(
				/\bteam\b|\bteams\b|\boperator\b|\baccount\b/i,
			);
			expect(html).not.toContain('data-testid="team-switcher"');
			expect(html).toContain('aria-label="Navigation"');
			expect(html).toContain('href="/app/settings"');
			expect(html).toContain('href="/app"');
		}
	});
	it("retains the team switcher and operator view for explicit teams and old metadata", () => {
		const html = markup(metaTenancy({}));
		expect(html).toContain('data-testid="team-switcher"');
		expect(html).toContain('aria-label="Team navigation"');
		expect(html).toContain('href="/app/operator"');
	});
	it("does not mention the internal team in API key headings, descriptions or ARIA", () => {
		const html = markup(
			"single",
			createElement(KeysPage, { teamId: "team_local" }),
		);
		expect(visibleText(html)).not.toMatch(/\bteams?\b/i);
		expect(html).toContain('aria-label="New API key"');
		expect(html).not.toContain('aria-label="New team API key"');
	});
	it("keeps quota, permission and duplicate errors in deployment terms", () => {
		for (const code of [
			"quota_exceeded",
			"slug_taken",
			"team_forbidden",
			"forbidden",
		]) {
			const error = new UmiakError({
				code,
				status: 403,
				message: "Denied",
				retryable: false,
				details: { reason: "role" },
			});
			expect(describeError(error, true).message).not.toMatch(
				/\bteams?\b|\bmembers?\b/i,
			);
		}
		const error = new UmiakError({
			code: "team_forbidden",
			status: 403,
			message: "Denied",
			retryable: false,
			details: {},
		});
		expect(describeError(error).message).toContain("team");
	});
});

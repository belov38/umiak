import { expect, it, vi } from "vitest";

const { getAppSession, redirect } = vi.hoisted(() => ({
	getAppSession: vi.fn(),
	redirect: vi.fn((path: string) => {
		throw new Error(path);
	}),
}));
vi.mock("@/lib/session", () => ({ getAppSession }));
vi.mock("next/navigation", () => ({ redirect }));

it.each(["snapshots", "environments", "keys"])(
	"resolves the setup shell's %s link to the default team",
	async (route) => {
		const page = await import(`../src/app/(app)/app/${route}/page`);
		getAppSession.mockResolvedValue({ defaultTeamId: "team_test" });
		await expect(page.default()).rejects.toThrow(`/app/t/team_test/${route}`);
		getAppSession.mockResolvedValue({ defaultTeamId: "" });
		await expect(page.default()).rejects.toThrow("/app");
	},
);

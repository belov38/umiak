import { expect, test } from "./fixtures.ts";

test("Templates explain snapshots and show read-only member catalog", async ({
	as,
}) => {
	const { page } = await as("alice");
	await page.getByRole("link", { name: "Templates", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Templates", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId("template-card")).toHaveCount(3);
	await expect(
		page.getByRole("heading", {
			name: "Windows 11 (with desktop)",
			exact: true,
		}),
	).toBeVisible();
	const card = page.getByTestId("template-card").first();
	await expect(card).toBeVisible();
	for (const field of [
		"OS",
		"Capabilities",
		"Default size",
		"Allowed sizes",
		"Enabled",
		"Active version",
		"Build date",
		"Slot / VMID",
	]) {
		await expect(card.getByText(field, { exact: true })).toBeVisible();
	}
	await expect(
		page.getByRole("button", { name: /^(Disable|Enable|Rebuild|Build)/ }),
	).toHaveCount(0);
	await page.getByRole("link", { name: "snapshot", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Snapshots", exact: true }),
	).toBeVisible();
});

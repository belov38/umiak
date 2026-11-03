import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../src/lib/team-actions/core";
import { setTemplateEnabledImpl } from "../src/lib/template-actions";

function context(operator: boolean) {
	return {
		session: { isOperator: operator },
		payload: {
			find: vi.fn(async () => ({ docs: [{ id: "template-id" }] })),
			update: vi.fn(async () => ({})),
		},
	} as unknown as ActionCtx;
}
describe("template configuration", () => {
	it("refuses a member before accessing configuration", async () => {
		const ctx = context(false);
		expect(
			await setTemplateEnabledImpl(ctx, { slug: "linux", enabled: false }),
		).toHaveProperty("error.code", "forbidden");
		expect(ctx.payload.find).not.toHaveBeenCalled();
	});
	it("updates only the enabled flag of the named template", async () => {
		const ctx = context(true);
		expect(
			await setTemplateEnabledImpl(ctx, { slug: "linux", enabled: false }),
		).toEqual({ ok: true });
		expect(ctx.payload.update).toHaveBeenCalledWith({
			collection: "templates",
			id: "template-id",
			data: { enabled: false },
			overrideAccess: true,
		});
	});
	it("rejects malformed input without writing", async () => {
		const ctx = context(true);
		expect(
			await setTemplateEnabledImpl(ctx, {
				slug: "linux;anything",
				enabled: false,
			}),
		).toHaveProperty("error.code", "validation");
		expect(ctx.payload.update).not.toHaveBeenCalled();
	});
});

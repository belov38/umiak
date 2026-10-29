import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/context.ts";

describe("createLogger", () => {
	it("redacts secret-bearing fields at the top level and one level down", () => {
		const lines: string[] = [];
		const log = createLogger(
			{},
			new Writable({
				write(chunk, _enc, cb) {
					lines.push(String(chunk));
					cb();
				},
			}),
		);
		log.info(
			{
				env: { A: "marker-env" },
				secretFiles: [{ name: "f", contentBase64: "marker-file" }],
				req: {
					secrets: { K: "marker-secret" },
					secretEnv: { K: "marker-secret-env" },
					bs: "marker-bs",
					token: "marker-token",
					serial: "marker-serial",
				},
				machineId: "visible",
			},
			"hello",
		);
		const out = lines.join("");
		expect(out).toContain("visible");
		expect(out).not.toMatch(/marker-/);
	});
});

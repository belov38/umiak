// PTY client parts that need no api: input queued while not connected.
import { describe, expect, it } from "vitest";
import type { ClientCore } from "../src/client.ts";
import { Command } from "../src/commands.ts";
import { SbxError } from "../src/errors.ts";
import { Pty } from "../src/pty.ts";

describe("Pty input while not connected", () => {
	it("queues up to 1 MiB, then throws pty_input_overflow", () => {
		// Credentials never resolve: the PTY never connects.
		const core = {
			credentials: () => new Promise(() => {}),
			userAgent: "test",
		} as unknown as ClientCore;
		const pty = new Pty(core, new Command({ core, id: "sb_1" }, "cmd_1"), {});
		pty.write(new Uint8Array(1024 * 1024));
		let err: unknown;
		try {
			pty.write("x");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({ code: "pty_input_overflow", retryable: true });
		pty.close();
	});
});

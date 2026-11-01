// force_stop of sandbox_fork and snapshot_save (S9 §24.8) against the fake
// API: a running Windows sandbox without it is 409 snapshot_requires_stop
// with a hint to retry with force_stop: true; with it the flag reaches the
// API and the operation reports the stop and restart.
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./helpers/harness.ts";

let h: Harness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function sandbox(hh: Harness, template: string): Promise<string> {
	const r = await hh.call("sandbox_create", { template });
	expect(r.json.state).toBe("ready");
	return r.json.id as string;
}

const HINT = "retry with force_stop: true to stop and restart the sandbox";

describe("force_stop", () => {
	it("sandbox_fork of a running Windows sandbox: the hint, then force_stop: true goes through", async () => {
		h = await startHarness();
		const sb = await sandbox(h, "windows");
		const no = await h.call("sandbox_fork", { sandbox: sb });
		expect(no.isError).toBe(true);
		expect(no.texts[0]).toContain("error: snapshot_requires_stop");
		expect(no.texts[0]).toContain(
			"Windows sandboxes are forked from a stopped VM",
		);
		expect(no.texts[0]).toContain(HINT);

		const ok = await h.call("sandbox_fork", { sandbox: sb, force_stop: true });
		expect(ok.isError).toBe(false);
		expect(ok.json.state).toBe("ready");
		const posts = h.to("POST", `/v1/sandboxes/${sb}/fork`);
		expect(posts[0]?.body).toEqual({});
		expect(posts[1]?.body).toEqual({ forceStop: true });
	});

	it("snapshot_save of a running Windows sandbox: the hint, then a powered_off snapshot", async () => {
		h = await startHarness();
		const sb = await sandbox(h, "windows");
		const no = await h.call("snapshot_save", { sandbox: sb, name: "win" });
		expect(no.isError).toBe(true);
		expect(no.texts[0]).toContain("error: snapshot_requires_stop");
		expect(no.texts[0]).toContain(HINT);

		const ok = await h.call("snapshot_save", {
			sandbox: sb,
			name: "win",
			force_stop: true,
		});
		expect(ok.isError).toBe(false);
		expect(ok.json).toMatchObject({
			state: "ready",
			operation: { kind: "save_snapshot", state: "succeeded" },
		});
		const listed = await h.call("snapshot_list");
		expect(listed.json.snapshots[0]).toMatchObject({
			name: "win",
			consistency: "powered_off",
		});
		expect(h.to("POST", "/v1/snapshots")[1]?.body).toEqual({
			sandbox: sb,
			name: "win",
			forceStop: true,
		});
	});

	it("a failed source restart is reported by sandbox_fork and snapshot_save alike", async () => {
		h = await startHarness();
		const sb = await sandbox(h, "windows");
		h.api.state.forceStopRestartError = {
			code: "agent_timeout",
			message: "the agent did not connect in time",
		};
		const fork = await h.call("sandbox_fork", {
			sandbox: sb,
			force_stop: true,
		});
		expect(fork.isError).toBe(false);
		expect(fork.json.state).toBe("ready");
		expect(fork.json.source_operation).toMatchObject({ state: "succeeded" });
		const note =
			"did not start again after the forced stop (agent_timeout: the agent did not connect in time)";
		expect(fork.texts.join("\n")).toContain(note);
		expect(fork.texts.join("\n")).toContain("call sandbox_resume");

		const other = await sandbox(h, "windows");
		const save = await h.call("snapshot_save", {
			sandbox: other,
			name: "win",
			force_stop: true,
		});
		expect(save.isError).toBe(false);
		expect(save.texts.join("\n")).toContain(note);
	});

	it("a forced fork whose source restarted adds no note", async () => {
		h = await startHarness();
		const sb = await sandbox(h, "windows");
		const fork = await h.call("sandbox_fork", {
			sandbox: sb,
			force_stop: true,
		});
		expect(fork.texts.join("\n")).not.toContain("did not start again");
	});

	it("Linux ignores the flag; without it nothing is added to the body", async () => {
		h = await startHarness();
		const sb = await sandbox(h, "linux");
		const fork = await h.call("sandbox_fork", { sandbox: sb });
		expect(fork.isError).toBe(false);
		const save = await h.call("snapshot_save", {
			sandbox: sb,
			name: "lin",
			force_stop: true,
		});
		expect(save.isError).toBe(false);
		const listed = await h.call("snapshot_list");
		expect(listed.json.snapshots[0].consistency).toBe("quiesced");
		expect(h.to("POST", `/v1/sandboxes/${sb}/fork`)[0]?.body).toEqual({});
	});
});

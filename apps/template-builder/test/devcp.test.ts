import { describe, expect, it } from "vitest";
import { devCpRegistrar } from "../src/devcp.ts";

const MID = "0f8e2c1a-1111-4abc-8def-0123456789ab";
const HASH = "ab".repeat(32);

function setup(answer = "") {
	const calls: { args: string[]; sql: string }[] = [];
	const reg = devCpRegistrar({
		ctSsh: "sbx@192.168.68.90",
		exec: async (args, sql) => {
			calls.push({ args, sql });
			return answer;
		},
	});
	return { reg, calls };
}

describe("devCpRegistrar", () => {
	it("runs psql in the CT compose project with SQL on stdin", async () => {
		const { reg, calls } = setup();
		await reg.register(MID, HASH);
		expect(calls[0]?.args).toEqual([
			"-o",
			"BatchMode=yes",
			"sbx@192.168.68.90",
			"cd boat-dev-clone/deploy/compose && docker compose exec -T postgres psql -U sbx -d sbx -v ON_ERROR_STOP=1 -Atq",
		]);
		expect(calls[0]?.sql).toBe(
			`INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash) VALUES ('${MID}', '\\x${HASH}');\n`,
		);
	});

	it("reads the session state, null without a row", async () => {
		const { reg, calls } = setup("connected\n");
		expect(await reg.sessionState(MID)).toBe("connected");
		expect(calls[0]?.sql).toBe(
			`SELECT state FROM tunnel.tunnel_sessions WHERE machine_id = '${MID}';\n`,
		);
		expect(await setup("\n").reg.sessionState(MID)).toBeNull();
	});

	it("deletes the session and the credentials", async () => {
		const { reg, calls } = setup();
		await reg.unregister(MID);
		expect(calls[0]?.sql).toBe(
			`DELETE FROM tunnel.tunnel_sessions WHERE machine_id = '${MID}';\nDELETE FROM tunnel.tunnel_credentials WHERE machine_id = '${MID}';\n`,
		);
	});

	it("refuses values that are not a UUID or a SHA-256", async () => {
		const { reg, calls } = setup();
		await expect(reg.register("x'; DROP TABLE y; --", HASH)).rejects.toThrow(
			/machine id/,
		);
		await expect(reg.register(MID, "zz")).rejects.toThrow(/hash/);
		await expect(reg.unregister("1")).rejects.toThrow(/machine id/);
		expect(calls).toHaveLength(0);
	});

	it("refuses an ssh destination that looks like an option", () => {
		expect(() => devCpRegistrar({ ctSsh: "-oProxyCommand=x" })).toThrow(
			/dev-cp-ssh/,
		);
	});
});

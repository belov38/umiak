// Dev-only host coordination. Never stop another track's VM to make room.
import { execFileSync } from "node:child_process";

export function runningSandboxMemory(
	list: string,
	desktopOnly = false,
): number {
	const rows = list.trim().split("\n");
	if (!rows.shift()?.includes("VMID"))
		throw new Error("invalid qm list header");
	return rows.reduce((sum, line) => {
		const row = line.trim().split(/\s+/);
		if (Number(row[0]) < 500 || Number(row[0]) > 599 || row[2] !== "running")
			return sum;
		if (
			desktopOnly &&
			!(Number(row[0]) >= 580 && Number(row[0]) <= 589) &&
			![595, 596].includes(Number(row[0]))
		)
			return sum;
		const memory = Number(row[3]);
		if (!Number.isFinite(memory) || memory <= 0)
			throw new Error("invalid running VM memory");
		return sum + memory;
	}, 0);
}
export async function waitForDesktopBudget() {
	for (;;) {
		const list = execFileSync(
			"ssh",
			[
				"-o",
				"BatchMode=yes",
				"-o",
				"HostKeyAlias=pve.tail0000.ts.net",
				"root@100.64.10.2",
				"qm",
				"list",
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		console.log(list);
		const used = runningSandboxMemory(list);
		if (used + 4096 <= 8192 && runningSandboxMemory(list, true) === 0) return;
		console.log(`RAM budget occupied (${used} MiB), retry in 10s`);
		await new Promise((done) => setTimeout(done, 10_000));
	}
}

import { describe, expect, it } from "vitest";
import { agentReadyMs, parseSystemdAnalyze } from "../src/s5.ts";

describe("parseSystemdAnalyze", () => {
	it("reads kernel, initrd and userspace", () => {
		expect(
			parseSystemdAnalyze(
				"Startup finished in 1.234s (kernel) + 812ms (initrd) + 3.5s (userspace) = 5.546s",
			),
		).toEqual({ kernelMs: 1234, initrdMs: 812, userspaceMs: 3500 });
	});

	it("has no initrd part for an initrd-less boot", () => {
		expect(
			parseSystemdAnalyze(
				"Startup finished in 980ms (kernel) + 4.020s (userspace) = 5.000s\ngraphical.target reached",
			),
		).toEqual({ kernelMs: 980, initrdMs: null, userspaceMs: 4020 });
	});

	it("adds minutes and seconds", () => {
		expect(
			parseSystemdAnalyze(
				"Startup finished in 2.1s (kernel) + 1min 3.250s (userspace) = 1min 5.350s",
			).userspaceMs,
		).toBe(63250);
	});

	it("returns nulls when boot has not finished", () => {
		expect(
			parseSystemdAnalyze(
				"Bootup is not yet finished (org.freedesktop.systemd1.Manager.FinishTimestampMonotonic=0).",
			),
		).toEqual({ kernelMs: null, initrdMs: null, userspaceMs: null });
	});
});

describe("agentReadyMs", () => {
	it("maps the guest monotonic time to host time since start", () => {
		// start at 1000, ping at 9000 with uptime 6 s: the kernel started at host 3000;
		// the agent became active 6.5 s after kernel start: host 9500, 8500 after start.
		expect(agentReadyMs(1000, 9000, 6, 6_500_000)).toBe(8500);
	});

	it("is null without the agent unit", () => {
		expect(agentReadyMs(1000, 9000, 6, 0)).toBeNull();
		expect(agentReadyMs(1000, 9000, 6, Number.NaN)).toBeNull();
	});
});

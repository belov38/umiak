import { describe, expect, it } from "vitest";
import {
	stepRequestId,
	UMIAK_NAMESPACE,
	uuidv5,
	uuidv7,
} from "../src/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
	it("has version 7, RFC variant and the unix ms timestamp", () => {
		const now = 1_793_232_000_123;
		const id = uuidv7(now);
		expect(id).toMatch(UUID);
		expect(id[14]).toBe("7");
		expect("89ab").toContain(id[19]);
		const hex = id.replaceAll("-", "").slice(0, 12);
		expect(Number.parseInt(hex, 16)).toBe(now);
	});

	it("is unique and sorts by time across milliseconds", () => {
		const a = uuidv7(1000);
		const b = uuidv7(1001);
		expect(a < b).toBe(true);
		const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
		expect(set.size).toBe(1000);
	});

	it("rejects timestamps outside 48 bits", () => {
		expect(() => uuidv7(-1)).toThrow();
		expect(() => uuidv7(2 ** 48)).toThrow();
		expect(() => uuidv7(1.5)).toThrow();
	});
});

describe("uuidv5", () => {
	it("matches the RFC 9562 test vector", () => {
		expect(
			uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
		).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
	});

	it("uses UMIAK_NAMESPACE by default", () => {
		expect(UMIAK_NAMESPACE).toMatch(UUID);
		expect(uuidv5("x")).toBe(uuidv5("x", UMIAK_NAMESPACE));
		expect(uuidv5("x")[14]).toBe("5");
	});

	it("rejects a malformed namespace", () => {
		expect(() => uuidv5("x", "nope")).toThrow();
	});
});

describe("stepRequestId", () => {
	it("is deterministic and differs per step and operation", () => {
		const op = "0192f0a0-0000-7000-8000-000000000001";
		expect(stepRequestId(op, "claim")).toBe(stepRequestId(op, "claim"));
		expect(stepRequestId(op, "claim")).toBe(uuidv5(`${op}:claim`));
		expect(stepRequestId(op, "claim")).not.toBe(stepRequestId(op, "provision"));
		expect(stepRequestId(op, "claim")).not.toBe(
			stepRequestId("0192f0a0-0000-7000-8000-000000000002", "claim"),
		);
	});
});

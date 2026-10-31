// Default coordinate space of the desktop tools (S11 8.7, S10 12.1).
import { describe, expect, it } from "vitest";
import { convertPoint, defaultCoordinateSpace } from "../src/desktop/coords.ts";

describe("defaultCoordinateSpace", () => {
	it.each([
		[1920, 1080, 1280, 720],
		[1280, 800, 1280, 800],
		[3840, 2160, 1280, 720],
		[1024, 768, 1024, 768],
		[2560, 1600, 1280, 800],
	])("%ix%i screen -> %ix%i", (w, h, ew, eh) => {
		expect(defaultCoordinateSpace({ width: w, height: h })).toEqual({
			width: ew,
			height: eh,
		});
	});

	it("rounds like the API and never returns a zero side", () => {
		// 1366x768: scale 0.937..., 1280 x 719.6 -> 720.
		expect(defaultCoordinateSpace({ width: 1366, height: 768 })).toEqual({
			width: 1280,
			height: 720,
		});
		expect(defaultCoordinateSpace({ width: 5000, height: 1 })).toEqual({
			width: 1280,
			height: 1,
		});
	});

	it("takes another box", () => {
		expect(
			defaultCoordinateSpace(
				{ width: 1920, height: 1080 },
				{ width: 640, height: 640 },
			),
		).toEqual({ width: 640, height: 360 });
	});
});

describe("convertPoint", () => {
	it("maps a screen point into the space", () => {
		expect(
			convertPoint(
				{ x: 960, y: 540 },
				{ width: 1920, height: 1080 },
				{ width: 1280, height: 720 },
			),
		).toEqual({ x: 640, y: 360 });
	});
});

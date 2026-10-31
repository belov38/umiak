// Coordinates of the desktop tools (S11 8.7, S10 12.1-12.2). The server keeps
// no state between calls, so the default coordinate space of a click is
// computed from the screen size the same way the API scales a screenshot.

export interface Size {
	width: number;
	height: number;
}

/** The default screenshot box: 1280x800 (S11 8.7, 9.2). */
export const DEFAULT_SCREENSHOT_MAX: Size = { width: 1280, height: 800 };

/**
 * The size of a screenshot of `screen` scaled to fit `max` with the aspect
 * ratio kept and never upscaled (S10 12.1): `scale = min(maxW/w, maxH/h, 1)`,
 * sizes rounded.
 */
export function defaultCoordinateSpace(
	screen: Size,
	max: Size = DEFAULT_SCREENSHOT_MAX,
): Size {
	const scale = Math.min(
		max.width / screen.width,
		max.height / screen.height,
		1,
	);
	return {
		width: Math.max(1, Math.round(screen.width * scale)),
		height: Math.max(1, Math.round(screen.height * scale)),
	};
}

/** A point of `from` mapped into `to` (rounded). */
export function convertPoint(
	p: { x: number; y: number },
	from: Size,
	to: Size,
): { x: number; y: number } {
	return {
		x: Math.round((p.x * to.width) / from.width),
		y: Math.round((p.y * to.height) / from.height),
	};
}

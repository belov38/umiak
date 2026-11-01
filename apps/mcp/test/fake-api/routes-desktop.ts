// Desktop routes of S10 §12-§13.2: status, links, screenshot, actions,
// clipboard. The screen is a fixed gray image of the right size
// (images.ts); actions are recorded in `state.desktop.actions` and move the
// cursor, they do not sleep (`wait` and `delayMs` only count toward the
// 60 s limit of a request).
import type { Context } from "hono";
import { FakeApiError, validation } from "./errors.ts";
import { jpegBytes, pngBytes, scaleToFit } from "./images.ts";
import {
	hasCapability,
	lookupSandbox,
	requireReady,
	sandboxParam,
} from "./model.ts";
import type { Fake, FakeApp, FakeEnv, FakeSandbox } from "./state.ts";

type Json = Record<string, unknown>;
type Size = { width: number; height: number };

const NAMED_KEYS = new Set([
	"ctrl",
	"alt",
	"shift",
	"meta",
	"enter",
	"tab",
	"escape",
	"backspace",
	"delete",
	"insert",
	"space",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"capslock",
	"printscreen",
	"menu",
	...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);
const MAX_REQUEST_MS = 60_000;
const CLIPBOARD_MAX_BYTES = 1024 * 1024;

function validKey(k: string): boolean {
	return NAMED_KEYS.has(k) || [...k].length === 1;
}

function invalidAction(index: number, reason: string): FakeApiError {
	return new FakeApiError(400, "invalid_action", `action ${index}: ${reason}`, {
		details: { index, reason },
	});
}

function imageBytes(format: string, size: Size): Uint8Array {
	return format === "jpeg"
		? jpegBytes(size.width, size.height)
		: pngBytes(size.width, size.height);
}

export function registerDesktopRoutes(app: FakeApp, fake: Fake): void {
	const { desktop } = fake.state;
	const base = "/v1/sandboxes/:sandbox/desktop";

	async function target(
		c: Context<FakeEnv>,
	): Promise<{ sb: FakeSandbox; screen: Size }> {
		const sb = lookupSandbox(fake, c.get("principal"), sandboxParam(c));
		if (!hasCapability(fake, sb, "desktop")) {
			throw new FakeApiError(
				422,
				"desktop_unsupported",
				`template ${sb.template} has no desktop; create the sandbox from linux-desktop or windows`,
			);
		}
		await requireReady(fake, sb, c.req.raw.signal);
		return { sb, screen: desktop.screens.get(sb.id) ?? desktop.defaultScreen };
	}

	const cursorOf = (sb: FakeSandbox, screen: Size) =>
		desktop.cursors.get(sb.id) ?? {
			x: Math.floor(screen.width / 2),
			y: Math.floor(screen.height / 2),
		};

	app.get(base, async (c) => {
		const { sb, screen } = await target(c);
		return c.json({
			state: "ready",
			reason: null,
			screen,
			cursor: cursorOf(sb, screen),
			access: "token",
			url: `https://${sb.slug}-desktop.umiak.example.com/`,
			streamer: { running: true, streaming: false },
		});
	});

	app.post(`${base}/links`, async (c) => {
		const { sb } = await target(c);
		const b = (c.get("json") ?? {}) as Json;
		const ticket = fake.newId("ticket");
		const url = `https://${sb.slug}-desktop.umiak.example.com/?_ticket=${ticket}&fps=${String(b.fps ?? 30)}`;
		desktop.links.push({ sandboxId: sb.id, url });
		return c.json(
			{ url, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
			201,
		);
	});

	app.get(`${base}/screenshot`, async (c) => {
		const { sb, screen } = await target(c);
		const q = (name: string) =>
			c.req.query(name) === undefined ? undefined : Number(c.req.query(name));
		const region = {
			x: q("x"),
			y: q("y"),
			width: q("width"),
			height: q("height"),
		};
		let source: Size = screen;
		if (Object.values(region).some((v) => v !== undefined)) {
			if (region.width === undefined || region.height === undefined) {
				throw validation([
					{ path: "query.width", message: "a region needs width and height" },
				]);
			}
			const x = region.x ?? 0;
			const y = region.y ?? 0;
			if (
				x + region.width > screen.width ||
				y + region.height > screen.height
			) {
				throw new FakeApiError(
					400,
					"invalid_action",
					`the region ${x},${y} ${region.width}x${region.height} is outside the ${screen.width}x${screen.height} screen`,
					{
						details: { reason: "region_outside_screen" },
					},
				);
			}
			source = { width: region.width, height: region.height };
		}
		const image = scaleToFit(
			source.width,
			source.height,
			q("maxWidth"),
			q("maxHeight"),
		);
		const format = c.req.query("format") ?? "png";
		desktop.screenshots.push({
			sandboxId: sb.id,
			query: Object.fromEntries(new URL(c.req.url).searchParams),
		});
		const cursor = cursorOf(sb, screen);
		return new Response(imageBytes(format, image) as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
				"Cache-Control": "no-store",
				"Umiak-Screen-Width": String(screen.width),
				"Umiak-Screen-Height": String(screen.height),
				"Umiak-Image-Width": String(image.width),
				"Umiak-Image-Height": String(image.height),
				"Umiak-Cursor-X": String(cursor.x),
				"Umiak-Cursor-Y": String(cursor.y),
			},
		});
	});

	app.post(`${base}/actions`, async (c) => {
		const { sb, screen } = await target(c);
		const b = c.get("json") as {
			actions: Json[];
			coordinateSpace?: Size;
			screenshot?: { format?: string; maxWidth?: number; maxHeight?: number };
		};
		const space = b.coordinateSpace ?? screen;
		// The whole list is checked before the first action runs (S10 §12.2).
		let durationMs = 0;
		let cursor = cursorOf(sb, screen);
		const inside = (i: number, p: { x: number; y: number }) => {
			if (p.x < 0 || p.y < 0 || p.x >= space.width || p.y >= space.height) {
				throw invalidAction(
					i,
					`(${p.x}, ${p.y}) is outside the ${space.width}x${space.height} coordinate space`,
				);
			}
			return {
				x: Math.round((p.x * screen.width) / space.width),
				y: Math.round((p.y * screen.height) / space.height),
			};
		};
		b.actions.forEach((a, i) => {
			const type = a.type as string;
			if (typeof a.x === "number" && typeof a.y === "number")
				cursor = inside(i, { x: a.x, y: a.y });
			else if ((typeof a.x === "number") !== (typeof a.y === "number")) {
				throw invalidAction(i, "x and y go together");
			}
			if (type === "drag") {
				const path = a.path as { x: number; y: number }[];
				for (const pt of path) cursor = inside(i, pt);
			}
			for (const k of [
				...((a.keys as string[] | undefined) ?? []),
				...(typeof a.key === "string" ? [a.key] : []),
				...((a.modifiers as string[] | undefined) ?? []),
			]) {
				if (!validKey(k))
					throw invalidAction(i, `unknown key name ${JSON.stringify(k)}`);
			}
			if (type === "wait") durationMs += a.ms as number;
			if (type === "type")
				durationMs +=
					[...(a.text as string)].length *
					((a.delayMs as number | undefined) ?? 5);
		});
		if (durationMs > MAX_REQUEST_MS) {
			throw invalidAction(
				0,
				`the actions take about ${durationMs} ms; a request is limited to ${MAX_REQUEST_MS} ms`,
			);
		}
		desktop.cursors.set(sb.id, cursor);
		desktop.actions.push({
			sandboxId: sb.id,
			actions: b.actions,
			coordinateSpace: b.coordinateSpace ?? null,
			screenshot: (b.screenshot as Json | undefined) ?? null,
		});
		const result: Json = { completed: b.actions.length, cursor, screen };
		if (b.screenshot) {
			const image = scaleToFit(
				screen.width,
				screen.height,
				b.screenshot.maxWidth,
				b.screenshot.maxHeight,
			);
			const format = b.screenshot.format ?? "png";
			result.screenshot = {
				contentType: format === "jpeg" ? "image/jpeg" : "image/png",
				width: image.width,
				height: image.height,
				data: Buffer.from(imageBytes(format, image)).toString("base64"),
			};
		}
		return c.json(result);
	});

	app.get(`${base}/clipboard`, async (c) => {
		const { sb } = await target(c);
		const text = desktop.clipboards.get(sb.id) ?? "";
		return c.json({ text, hasText: text !== "" });
	});

	app.put(`${base}/clipboard`, async (c) => {
		const { sb } = await target(c);
		const { text } = c.get("json") as { text: string };
		if (Buffer.byteLength(text) > CLIPBOARD_MAX_BYTES) {
			throw validation([{ path: "text", message: "at most 1 MiB" }]);
		}
		desktop.clipboards.set(sb.id, text);
		return c.body(null, 204);
	});
}

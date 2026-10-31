// The desktop API of S10 (13.1-13.2) through `sbx.raw`. The routes are not in
// apps/api/openapi/v1.json yet (S10 is not implemented), so the raw client is
// used with a cast and every answer is checked here. When S10 lands, SDK
// helpers replace this module. Names of JSON fields are camelCase, as in the
// rest of the public API.
import { type Sbx, SbxError, UNEXPECTED_RESPONSE } from "@sbx/sdk";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { safeLine } from "../output/sanitize.ts";
import type { Size } from "./coords.ts";

/** `computer_type` may type for this long (S11 7.5): the rest of the 50 s is for settle and the answer. */
export const TYPE_BUDGET_MS = 40_000;
/** `GET /desktop` is read at most this often per sandbox in a process. */
export const SCREEN_CACHE_MS = 10_000;

export interface Point {
	x: number;
	y: number;
}

export interface DesktopStatus {
	state: string;
	reason: string | null;
	screen: Size;
	cursor: Point;
	access: string;
	url: string;
	streamer: { running: boolean; streaming: boolean };
}

export interface DesktopLink {
	url: string;
	expiresAt: string;
}

export interface ScreenshotQuery {
	format: "jpeg" | "png";
	quality?: number;
	maxWidth: number;
	maxHeight: number;
	/** The region, in screen pixels, before scaling. */
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface Screenshot {
	bytes: Uint8Array;
	contentType: "image/jpeg" | "image/png";
	screen: Size;
	image: Size;
	/** Screen pixels. */
	cursor: Point;
}

export type DesktopAction =
	| { type: "move"; x: number; y: number }
	| {
			type: "click";
			x?: number;
			y?: number;
			button?: string;
			count?: number;
			modifiers?: string[];
	  }
	| { type: "scroll"; x?: number; y?: number; dx?: number; dy?: number }
	| { type: "drag"; path: Point[]; button?: string }
	| { type: "key"; keys: string[] }
	| { type: "type"; text: string; delayMs: number }
	| { type: "wait"; ms: number };

export interface ActionsBody {
	actions: DesktopAction[];
	coordinateSpace?: Size;
	screenshot?: {
		format: "jpeg" | "png";
		quality?: number;
		maxWidth: number;
		maxHeight: number;
	};
}

export interface ActionsResult {
	completed: number;
	/** Screen pixels. */
	cursor: Point;
	screen: Size;
	screenshot?: {
		contentType: "image/jpeg" | "image/png";
		width: number;
		height: number;
		/** base64 */
		data: string;
	};
}

interface LooseInit {
	params: {
		path: { sandbox: string };
		query?: Record<string, string | number>;
	};
	body?: unknown;
	parseAs?: "arrayBuffer";
	signal: AbortSignal;
	retryBudgetMs: number;
}

interface LooseRaw {
	GET(
		url: string,
		init: LooseInit,
	): Promise<{ data: unknown; response: Response }>;
	POST(
		url: string,
		init: LooseInit,
	): Promise<{ data: unknown; response: Response }>;
	PUT(
		url: string,
		init: LooseInit,
	): Promise<{ data: unknown; response: Response }>;
}

const DESKTOP = "/v1/sandboxes/{sandbox}/desktop";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An answer that does not fit the S10 contract: the API is wrong, not the model. */
function unexpected(what: string): SbxError {
	return new SbxError({
		status: 502,
		code: UNEXPECTED_RESPONSE,
		message: `the desktop API sent an unexpected ${what}`,
		retryable: false,
	});
}

function intOf(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isInteger(v)) throw unexpected(what);
	return v;
}

/** A width and height, both at least 1: a 0 would make every coordinate space 1x1. */
function sizeOf(v: unknown, what: string): Size {
	if (!isRecord(v)) throw unexpected(what);
	return sizeFrom(v.width, v.height, what);
}

function sizeFrom(width: unknown, height: unknown, what: string): Size {
	const size = { width: intOf(width, what), height: intOf(height, what) };
	if (size.width < 1 || size.height < 1) throw unexpected(what);
	return size;
}

function pointOf(v: unknown, what: string): Point {
	if (!isRecord(v)) throw unexpected(what);
	return { x: intOf(v.x, what), y: intOf(v.y, what) };
}

function imageType(v: unknown): "image/jpeg" | "image/png" {
	const type = String(v ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (type === "image/jpeg" || type === "image/png") return type;
	throw unexpected("image type");
}

interface CachedScreen {
	screen: Size;
	at: number;
}

/** The cache is bounded: expired entries are dropped when it grows past this. */
const SCREEN_CACHE_MAX = 500;

/**
 * Screen sizes. A sandbox id is unique in the whole API, so ids share one
 * in-process map (an HTTP server builds an SDK client per request); a slug is
 * unique only in a team, so slugs are cached per SDK client.
 */
const screensById = new Map<string, CachedScreen>();
const screensBySbx = new WeakMap<Sbx, Map<string, CachedScreen>>();

function screenCache(sbx: Sbx, sandbox: string): Map<string, CachedScreen> {
	if (sandbox.toLowerCase().startsWith("sb_")) return screensById;
	let map = screensBySbx.get(sbx);
	if (map === undefined) {
		map = new Map();
		screensBySbx.set(sbx, map);
	}
	return map;
}

function remember(sbx: Sbx, sandbox: string, screen: Size): void {
	const map = screenCache(sbx, sandbox);
	const now = Date.now();
	if (map.size >= SCREEN_CACHE_MAX) {
		for (const [k, v] of map) if (now - v.at >= SCREEN_CACHE_MS) map.delete(k);
	}
	map.set(sandbox, { screen, at: now });
}

function recall(sbx: Sbx, sandbox: string): Size | undefined {
	const hit = screenCache(sbx, sandbox).get(sandbox);
	return hit !== undefined && Date.now() - hit.at < SCREEN_CACHE_MS
		? hit.screen
		: undefined;
}

/** Forgets every cached screen size (tests). */
export function clearScreenCache(): void {
	screensById.clear();
}

export interface DesktopApi {
	status(): Promise<DesktopStatus>;
	/** The screen size: `GET /desktop`, cached for SCREEN_CACHE_MS; not ready is `desktop_not_ready`. */
	screen(): Promise<Size>;
	link(): Promise<DesktopLink>;
	screenshot(q: ScreenshotQuery): Promise<Screenshot>;
	act(body: ActionsBody): Promise<ActionsResult>;
	clipboardGet(): Promise<{ text: string; hasText: boolean }>;
	clipboardSet(text: string): Promise<void>;
}

export function desktopApi(ctx: ToolContext, sandbox: string): DesktopApi {
	const sbx = ctx.sbx();
	const raw = sbx.raw as unknown as LooseRaw;
	const init = (
		extra: Pick<LooseInit, "body" | "parseAs"> & {
			query?: Record<string, string | number>;
		} = {},
	): LooseInit => {
		const { query, ...rest } = extra;
		return {
			params: {
				path: { sandbox },
				...(query === undefined ? {} : { query }),
			},
			...rest,
			...ctx.call,
		};
	};

	/**
	 * A 404 from a desktop route is either an unknown sandbox or an API without
	 * the desktop routes: the sandbox is read to tell them apart.
	 */
	async function gated<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (err) {
			if (!(err instanceof SbxError) || err.status !== 404) throw err;
			const exists = await sbx.raw
				.GET("/v1/sandboxes/{sandbox}", {
					params: { path: { sandbox } },
					...ctx.call,
				})
				.then(
					() => true,
					() => false,
				);
			if (!exists) throw err;
			throw new ToolError({
				code: "desktop_unsupported",
				message: "this API has no desktop endpoints yet (S10)",
				hint: "desktop and computer-use tools do not work with this deployment yet; tell the user, and use exec and files tools instead.",
			});
		}
	}

	async function status(): Promise<DesktopStatus> {
		const { data } = await gated(() => raw.GET(DESKTOP, init()));
		if (!isRecord(data) || typeof data.state !== "string") {
			throw unexpected("desktop status");
		}
		return {
			state: data.state,
			reason: typeof data.reason === "string" ? data.reason : null,
			screen: sizeOf(data.screen, "screen size"),
			cursor: pointOf(data.cursor, "cursor"),
			access: String(data.access ?? ""),
			url: String(data.url ?? ""),
			streamer: {
				running: isRecord(data.streamer) && data.streamer.running === true,
				streaming: isRecord(data.streamer) && data.streamer.streaming === true,
			},
		};
	}

	return {
		status,
		async screen() {
			const cached = recall(sbx, sandbox);
			if (cached !== undefined) return cached;
			const st = await status();
			if (st.state !== "ready") {
				// Only a desktop that is starting gets better by itself.
				throw new ToolError({
					code: "desktop_not_ready",
					message: `the desktop is ${safeLine(st.state)}${st.reason === null ? "" : `: ${safeLine(st.reason)}`}`,
					retryable: st.state === "starting",
				});
			}
			remember(sbx, sandbox, st.screen);
			return st.screen;
		},
		async link() {
			const { data } = await gated(() => raw.POST(`${DESKTOP}/links`, init()));
			if (
				!isRecord(data) ||
				typeof data.url !== "string" ||
				typeof data.expiresAt !== "string"
			) {
				throw unexpected("desktop link");
			}
			return { url: data.url, expiresAt: data.expiresAt };
		},
		async screenshot(q) {
			const { data, response } = await gated(() =>
				raw.GET(
					`${DESKTOP}/screenshot`,
					init({
						parseAs: "arrayBuffer",
						query: Object.fromEntries(
							Object.entries(q).filter(([, v]) => v !== undefined),
						) as Record<string, string | number>,
					}),
				),
			);
			if (!(data instanceof ArrayBuffer)) throw unexpected("screenshot body");
			// A missing header is null, and Number(null) is 0: read the text.
			const h = (name: string): number => {
				const text = response.headers.get(name);
				return text !== null && /^-?\d+$/.test(text.trim())
					? Number(text)
					: Number.NaN;
			};
			const screen = sizeFrom(
				h("Sbx-Screen-Width"),
				h("Sbx-Screen-Height"),
				"screenshot screen size",
			);
			const image = sizeFrom(
				h("Sbx-Image-Width"),
				h("Sbx-Image-Height"),
				"screenshot image size",
			);
			const cursor = { x: h("Sbx-Cursor-X"), y: h("Sbx-Cursor-Y") };
			if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y)) {
				throw unexpected("screenshot cursor");
			}
			remember(sbx, sandbox, screen);
			return {
				bytes: new Uint8Array(data),
				contentType: imageType(response.headers.get("Content-Type")),
				screen,
				image,
				cursor,
			};
		},
		async act(body) {
			// No SDK retry: a retryable error (desktop_busy, streamer_unavailable)
			// goes to the model at once, which decides whether to repeat the input.
			const { data } = await gated(() =>
				raw.POST(`${DESKTOP}/actions`, { ...init({ body }), retryBudgetMs: 0 }),
			);
			if (!isRecord(data)) throw unexpected("actions result");
			const screen = sizeOf(data.screen, "screen size");
			remember(sbx, sandbox, screen);
			const shot = data.screenshot;
			if (shot !== undefined && !isRecord(shot)) throw unexpected("screenshot");
			if (shot !== undefined && typeof shot.data !== "string") {
				throw unexpected("screenshot data");
			}
			return {
				completed: intOf(data.completed, "completed"),
				cursor: pointOf(data.cursor, "cursor"),
				screen,
				...(shot === undefined
					? {}
					: {
							screenshot: {
								contentType: imageType(shot.contentType),
								...sizeFrom(shot.width, shot.height, "screenshot size"),
								data: shot.data as string,
							},
						}),
			};
		},
		async clipboardGet() {
			const { data } = await gated(() =>
				raw.GET(`${DESKTOP}/clipboard`, init()),
			);
			if (!isRecord(data) || typeof data.text !== "string") {
				throw unexpected("clipboard");
			}
			return { text: data.text, hasText: data.hasText === true };
		},
		async clipboardSet(text) {
			await gated(() =>
				raw.PUT(`${DESKTOP}/clipboard`, init({ body: { text } })),
			);
		},
	};
}

import { createRoute, type RouteConfig, z } from "@hono/zod-openapi";
import type { Sandbox } from "@sbx/core";
import { stepRequestId } from "@sbx/core";
import type { Context } from "hono";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { revokeDesktop } from "../desktop/revocation.ts";
import {
	desktopPolicy,
	desktopRpc,
	desktopSandbox,
	desktopUrl,
	issueDesktopLink,
} from "../desktop/service.ts";
import { ApiError } from "../http/errors.ts";
import { idempotencyKeyHeader } from "../http/idempotency.ts";
import {
	ERROR_RESPONSES,
	jsonBody,
	jsonResponse,
	optionalJsonBody,
} from "../openapi/registry.ts";
import { SandboxParams } from "../schemas/common.ts";
import { poolOf, readJson } from "./internal/common.ts";

export const DesktopSize = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});
export const DesktopPoint = z.object({
	x: z.number().int(),
	y: z.number().int(),
});
export const ScreenshotOptions = z.object({
	format: z.enum(["png", "jpeg"]).optional(),
	quality: z.number().int().min(1).max(100).optional(),
	maxWidth: z.number().int().positive().max(16384).optional(),
	maxHeight: z.number().int().positive().max(16384).optional(),
});
const coordinate = z.number().int().nonnegative();
const button = z.enum(["left", "right", "middle"]);
const xy = { x: coordinate.optional(), y: coordinate.optional() };
const Action = z.discriminatedUnion("type", [
	z.object({ type: z.literal("move"), x: coordinate, y: coordinate }),
	z.object({
		type: z.literal("click"),
		...xy,
		button: button.optional(),
		count: z.number().int().min(1).max(3).optional(),
		modifiers: z.array(z.enum(["ctrl", "alt", "shift", "meta"])).optional(),
	}),
	z.object({
		type: z.enum(["mouse_down", "mouse_up"]),
		...xy,
		button: button.optional(),
	}),
	z.object({
		type: z.literal("scroll"),
		...xy,
		dx: z.number().int().optional(),
		dy: z.number().int().optional(),
	}),
	z.object({
		type: z.literal("drag"),
		path: z.array(DesktopPoint).min(2).max(1000),
		button: button.optional(),
	}),
	z.object({
		type: z.literal("key"),
		keys: z.array(z.string().min(1)).min(1).max(16),
	}),
	z.object({ type: z.enum(["key_down", "key_up"]), key: z.string().min(1) }),
	z.object({
		type: z.literal("type"),
		text: z.string().max(20000),
		delayMs: z.number().int().min(0).max(100).optional(),
	}),
	z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(10000) }),
]);
export const DesktopActions = z.object({
	actions: z.array(Action).min(1).max(100),
	coordinateSpace: DesktopSize.optional(),
	screenshot: ScreenshotOptions.optional(),
});
const Shot = z.object({
	contentType: z.enum(["image/png", "image/jpeg"]),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	data: z.string(),
});
const ActionsResult = z.object({
	completed: z.number().int(),
	screen: DesktopSize,
	cursor: DesktopPoint,
	screenshot: Shot.optional(),
});
const Status = z.object({
	state: z.enum(["ready", "starting", "unavailable"]),
	reason: z.string().nullable(),
	screen: DesktopSize,
	cursor: DesktopPoint,
	access: z.enum(["token", "sso", "public"]),
	url: z.string(),
	streamer: z.object({ running: z.boolean(), streaming: z.boolean() }),
});
const Query = z.object({
	format: z.enum(["png", "jpeg"]).optional(),
	quality: z.coerce.number().int().min(1).max(100).optional(),
	maxWidth: z.coerce.number().int().positive().max(16384).optional(),
	maxHeight: z.coerce.number().int().positive().max(16384).optional(),
	x: z.coerce.number().int().nonnegative().optional(),
	y: z.coerce.number().int().nonnegative().optional(),
	width: z.coerce.number().int().positive().optional(),
	height: z.coerce.number().int().positive().optional(),
	cursor: z.enum(["true", "false"]).optional(),
});

/** Operations refused on an operator-blocked sandbox; ending streams stays allowed. */
const GUEST_WRITES = new Set(["link", "access", "setClipboard", "act"]);

export function registerDesktopRoutes(app: ApiApp, deps: ApiDeps): void {
	const add = (
		method: "get" | "post" | "put" | "patch" | "delete",
		suffix: string,
		id: string,
		response: z.ZodType | undefined,
		run: (
			c: Context<ApiEnv>,
			s: Sandbox,
			body: Record<string, unknown>,
		) => Promise<Response>,
		body?: z.ZodType,
		success = 200,
		optionalBody = false,
	) => {
		const noBody = response === undefined;
		const route = createRoute({
			method,
			path: `/v1/sandboxes/{sandbox}/desktop${suffix}`,
			operationId: `desktop.${id}`,
			tags: ["desktop"],
			summary: `Desktop ${id}`,
			description: `${id} for the sandbox desktop. Requires the desktop template capability and a ready sandbox.`,
			middleware: [
				requireScope(id === "status" ? "sandboxes:read" : "desktop"),
			] as const,
			request: {
				params: SandboxParams,
				...(body
					? {
							body: optionalBody
								? optionalJsonBody(body, "Desktop request")
								: jsonBody(body, "Desktop request"),
						}
					: {}),
			},
			responses: {
				[noBody ? 204 : success]: noBody
					? { description: "Done" }
					: jsonResponse(response as z.ZodType, "Desktop response"),
				...ERROR_RESPONSES,
			},
		});
		app.openapi(route as RouteConfig, async (c) => {
			const s = await desktopSandbox(deps, c, c.req.param("sandbox") ?? "", {
				write: GUEST_WRITES.has(id),
			});
			const input =
				body && (!optionalBody || c.req.header("content-type"))
					? await readJson(c, body)
					: {};
			c.header("Cache-Control", "no-store");
			return run(c, s, input as Record<string, unknown>);
		});
	};
	add("get", "", "status", Status, async (c, s) => {
		const r = await desktopRpc(
			deps,
			s.machineId as string,
			"status",
			{},
			c.req.raw.signal,
		);
		const p = await desktopPolicy(deps, s.id);
		return c.json({
			state: r.state,
			reason: r.reason || null,
			screen: r.screen ?? { width: 1920, height: 1080 },
			cursor: r.cursor ?? { x: 0, y: 0 },
			access: p.access,
			url: desktopUrl(deps, s.slug),
			streamer: {
				running: r.running === true,
				streaming: Number(r.desktopStreams) > 0,
			},
		});
	});
	add(
		"post",
		"/links",
		"link",
		z.object({ url: z.string(), expiresAt: z.string() }),
		async (c, s, body) => c.json(await issueDesktopLink(deps, c, s, body), 201),
		z.object({
			fps: z.union([z.literal(30), z.literal(60)]).optional(),
			bitrateKbps: z.number().int().min(1000).max(20000).optional(),
			transport: z.enum(["auto", "webrtc", "websocket"]).optional(),
		}),
		201,
		true,
	);
	add(
		"put",
		"/access",
		"access",
		z.object({ access: z.enum(["token", "sso", "public"]), url: z.string() }),
		async (c, s, body) => {
			const access = body.access as string;
			if (
				access === "public" &&
				!(await deps.config.defaults()).publicDesktopEnabled
			)
				throw new ApiError(403, "forbidden", "public desktops are disabled", {
					details: { reason: "public_disabled" },
				});
			await poolOf(deps).query(
				"UPDATE runtime.sandbox_desktops SET access=$2,updated_at=now() WHERE sandbox_id=$1",
				[s.id, access],
			);
			await revokeDesktop(deps, s.id, s.machineId);
			return c.json({ access, url: desktopUrl(deps, s.slug) });
		},
		z.object({ access: z.enum(["token", "sso", "public"]) }),
	);
	add("delete", "/streams", "endStreams", undefined, async (c, s) => {
		await revokeDesktop(deps, s.id, s.machineId);
		return c.body(null, 204);
	});

	add(
		"get",
		"/clipboard",
		"getClipboard",
		z.object({ text: z.string(), hasText: z.boolean() }),
		async (c, s) =>
			c.json(
				await desktopRpc(
					deps,
					s.machineId as string,
					"getClipboard",
					{},
					c.req.raw.signal,
				),
			),
	);
	add(
		"put",
		"/clipboard",
		"setClipboard",
		undefined,
		async (c, s, body) => {
			if (Buffer.byteLength(String(body.text), "utf8") > 1 << 20)
				throw new ApiError(400, "validation", "clipboard exceeds 1 MiB");
			await desktopRpc(
				deps,
				s.machineId as string,
				"setClipboard",
				body,
				c.req.raw.signal,
			);
			return c.body(null, 204);
		},
		z.object({ text: z.string().max(1 << 20) }),
	);
	add(
		"post",
		"/actions",
		"act",
		ActionsResult,
		async (c, s, body) => {
			const r = await desktopRpc(
				deps,
				s.machineId as string,
				"act",
				body,
				c.req.raw.signal,
				idempotencyKeyHeader(c)
					? stepRequestId(
							s.id,
							`desktop:${authOf(c).principal.apiKeyId ?? authOf(c).principal.userId}:${idempotencyKeyHeader(c)}`,
						)
					: undefined,
			);
			const shot = r.screenshot as
				| {
						contentType: string;
						data: string;
						image: { width: number; height: number };
				  }
				| undefined;
			return c.json({
				...r,
				...(shot
					? {
							screenshot: {
								contentType: shot.contentType,
								data: shot.data,
								...shot.image,
							},
						}
					: {}),
			});
		},
		DesktopActions,
	);
	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/sandboxes/{sandbox}/desktop/screenshot",
			operationId: "desktop.screenshot",
			summary: "Capture the desktop",
			description:
				"PNG or JPEG screen capture independent of the video streamer, with original screen, image and cursor metadata in response headers.",
			tags: ["desktop"],
			middleware: [requireScope("desktop")] as const,
			request: { params: SandboxParams, query: Query },
			responses: {
				200: {
					description: "Desktop screenshot",
					content: {
						"image/png": { schema: { type: "string", format: "binary" } },
						"image/jpeg": { schema: { type: "string", format: "binary" } },
					},
				},
				...ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const s = await desktopSandbox(deps, c, c.req.param("sandbox") ?? "");
			const q = c.req.valid("query");
			const { x, y, width, height, cursor, ...rest } = q;
			const crop = [x, y, width, height].filter((v) => v !== undefined);
			if (crop.length !== 0 && crop.length !== 4)
				throw new ApiError(
					400,
					"validation",
					"crop requires x, y, width and height",
				);
			const r = await desktopRpc(
				deps,
				s.machineId as string,
				"screenshot",
				{
					...rest,
					...(crop.length ? { region: { x, y, width, height } } : {}),
					...(cursor ? { cursor: cursor === "true" } : {}),
				},
				c.req.raw.signal,
			);
			const screen = r.screen as { width: number; height: number },
				image = r.image as { width: number; height: number },
				point = r.cursor as { x: number; y: number };
			for (const [k, v] of Object.entries({
				"Sbx-Screen-Width": screen.width,
				"Sbx-Screen-Height": screen.height,
				"Sbx-Image-Width": image.width,
				"Sbx-Image-Height": image.height,
				"Sbx-Cursor-X": point.x,
				"Sbx-Cursor-Y": point.y,
			}))
				c.header(k, String(v));
			c.header("Cache-Control", "no-store");
			c.header("Content-Type", String(r.contentType));
			return c.body(new Uint8Array(Buffer.from(String(r.data), "base64")), 200);
		},
	);
}

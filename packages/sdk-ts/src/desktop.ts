import type { CallOptions, ClientCore } from "./client.ts";
import { callOf } from "./commands.ts";
import type { operations } from "./gen/v1.d.ts";

export type DesktopActions =
	operations["desktop.act"]["requestBody"]["content"]["application/json"];
export type DesktopScreenshotQuery = NonNullable<
	operations["desktop.screenshot"]["parameters"]["query"]
>;
export type DesktopLinkOptions = NonNullable<
	operations["desktop.link"]["requestBody"]
>["content"]["application/json"];
const ROOT = "/v1/sandboxes/{sandbox}/desktop";
/** Desktop session operations. Actions are never automatically retried. */
export class Desktop {
	private readonly core: ClientCore;
	private readonly sandbox: string;
	constructor(core: ClientCore, sandbox: string) {
		this.core = core;
		this.sandbox = sandbox;
	}

	private path() {
		return { sandbox: this.sandbox };
	}
	async status(options: CallOptions = {}) {
		return (
			await this.core.raw.GET(ROOT, {
				params: { path: this.path() },
				...callOf(options),
			})
		).data;
	}
	async link(body: DesktopLinkOptions = {}, options: CallOptions = {}) {
		return (
			await this.core.raw.POST(`${ROOT}/links`, {
				params: { path: this.path() },
				body,
				...callOf(options),
			})
		).data;
	}
	async setAccess(
		access: "token" | "sso" | "public",
		options: CallOptions = {},
	) {
		return (
			await this.core.raw.PUT(`${ROOT}/access`, {
				params: { path: this.path() },
				body: { access },
				...callOf(options),
			})
		).data;
	}
	async endStreams(options: CallOptions = {}) {
		await this.core.raw.DELETE(`${ROOT}/streams`, {
			params: { path: this.path() },
			...callOf(options),
		});
	}
	async screenshot(
		query: DesktopScreenshotQuery = {},
		options: CallOptions = {},
	) {
		const { data, response } = await this.core.raw.GET(`${ROOT}/screenshot`, {
			params: { path: this.path(), query },
			parseAs: "arrayBuffer",
			...callOf(options),
		});
		const number = (name: string) => Number(response.headers.get(name));
		return {
			bytes: new Uint8Array(data),
			contentType: response.headers.get("content-type") ?? "image/png",
			screen: {
				width: number("Sbx-Screen-Width"),
				height: number("Sbx-Screen-Height"),
			},
			image: {
				width: number("Sbx-Image-Width"),
				height: number("Sbx-Image-Height"),
			},
			cursor: { x: number("Sbx-Cursor-X"), y: number("Sbx-Cursor-Y") },
		};
	}
	async act(body: DesktopActions, options: CallOptions = {}) {
		return (
			await this.core.raw.POST(`${ROOT}/actions`, {
				params: { path: this.path() },
				body,
				...callOf(options),
				retryBudgetMs: 0,
				timeoutMs: options.timeoutMs ?? 75_000,
			})
		).data;
	}
	async clipboardGet(options: CallOptions = {}) {
		return (
			await this.core.raw.GET(`${ROOT}/clipboard`, {
				params: { path: this.path() },
				...callOf(options),
			})
		).data;
	}
	async clipboardSet(text: string, options: CallOptions = {}) {
		await this.core.raw.PUT(`${ROOT}/clipboard`, {
			params: { path: this.path() },
			body: { text },
			...callOf(options),
		});
	}
}

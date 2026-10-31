// Fixtures of the E2E specs: signed-in browser contexts per test user
// (through the real Keycloak login), and the response audit of S8 §15
// "Security": every response a test's pages receive is scanned for
// `secretHash`, for secret values the test registers, and for one-time
// values (API key secrets, port tokens) after their dialog was closed.
import { createHash } from "node:crypto";
import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	test as base,
	expect,
	type Page,
	type Response,
	type WebSocket,
} from "@playwright/test";
import { APP, CONTROL } from "./env.ts";
import type { KcUser } from "./keycloak.ts";
import { type RunState, runState } from "./state.ts";

export { expect };

/** Responses not read: static build files, downloads and live streams. */
function skipped(r: Response): boolean {
	const url = r.url();
	const type = r.headers()["content-type"] ?? "";
	if (url.includes("/_next/static/")) return true;
	if (/\/files\/content|\/files\/archive|\/output\?/.test(url)) return true;
	if (type.includes("ndjson") || type.includes("octet-stream")) return true;
	return !/text\/|json|x-component/.test(type);
}

const SECRET_HASH_KEY = /\\*"secretHash\\*"\s*:/;

interface Seen {
	url: string;
	at: number;
	text: string;
}

interface Forbidden {
	value: string;
	label: string;
	/** Only responses after this time count (one-time values). */
	since: number;
}

export class ResponseAudit {
	readonly seen: Seen[] = [];
	readonly #pending = new Set<Promise<void>>();
	readonly #forbidden: Forbidden[] = [];

	attach(ctx: BrowserContext): void {
		ctx.on("response", (r) => {
			if (skipped(r)) return;
			const at = Date.now();
			const p = r
				.text()
				.then(
					(text) => {
						this.seen.push({ url: r.url(), at, text });
					},
					() => {},
				)
				.finally(() => this.#pending.delete(p));
			this.#pending.add(p);
		});
	}

	/** `value` must not appear in any response (since `since`). */
	forbid(value: string, label: string, since = 0): void {
		this.#forbidden.push({ value, label, since });
	}

	/**
	 * An API key secret: never after its dialog closed (`since`), and its
	 * stored hash (sha256 hex, S7 §7.2) never at all.
	 */
	forbidKey(secret: string, since: number): void {
		this.forbid(secret, "API key secret after its dialog", since);
		this.forbid(
			createHash("sha256").update(secret).digest("hex"),
			"API key secretHash value",
		);
	}

	/** Waits for the bodies in flight (bounded), then lists violations. */
	async violations(): Promise<string[]> {
		await Promise.race([
			Promise.all([...this.#pending]),
			new Promise((r) => setTimeout(r, 5000)),
		]);
		const out: string[] = [];
		for (const s of this.seen) {
			// `secretHash` with a value (plain or escaped JSON). The field's
			// name alone is in the Payload admin's client config (operators,
			// `admin.hidden`); its values are forbidden one by one (forbidKey).
			if (SECRET_HASH_KEY.test(s.text)) {
				out.push(`a secretHash value in ${s.url}`);
			}
			for (const f of this.#forbidden) {
				if (s.at >= f.since && s.text.includes(f.value)) {
					out.push(`${f.label} in ${s.url}`);
				}
			}
		}
		return out;
	}
}

/** Signs in through oauth2-proxy and the Keycloak login page. */
export async function signIn(page: Page, user: KcUser): Promise<void> {
	await page.goto("/app");
	await page.getByRole("textbox", { name: "Email" }).fill(user.email);
	await page.getByRole("textbox", { name: "Password" }).fill(user.password);
	await page.getByRole("button", { name: "Sign In" }).click();
	await page.waitForURL(/\/app\/t\/team_[0-9a-z]+/);
}

export interface Session {
	user: KcUser;
	context: BrowserContext;
	page: Page;
	/** API requests with this browser session's cookies. */
	request: APIRequestContext;
}

/** The team id (`team_…`) of the page's URL. */
export function teamOf(page: Page): string {
	const m = /\/app\/t\/(team_[0-9a-z]+)/.exec(page.url());
	if (!m?.[1]) throw new Error(`no team in ${page.url()}`);
	return m[1];
}

/** Headers of an unsafe dashboard API call (CSRF: Origin = the app). */
export function apiHeaders(teamId: string): Record<string, string> {
	return { "Sbx-Team": teamId, Origin: APP };
}

/** POST/PUT/GET of the e2e backend's control listener. */
export async function control<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: T }> {
	const r = await fetch(`${CONTROL}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: r.status, body: (await r.json()) as T };
}

type Fixtures = {
	state: RunState;
	audit: ResponseAudit;
	/** A new signed-in context of a test user (closed after the test). */
	as: (name: keyof RunState["users"]) => Promise<Session>;
};

async function newSession(
	browser: Browser,
	audit: ResponseAudit,
	user: KcUser,
): Promise<Session> {
	const context = await browser.newContext({ baseURL: APP });
	audit.attach(context);
	const page = await context.newPage();
	await signIn(page, user);
	return { user, context, page, request: context.request };
}

export const test = base.extend<Fixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
	state: async ({}, use) => {
		await use(runState());
	},
	audit: [
		async ({ context }, use) => {
			const audit = new ResponseAudit();
			audit.attach(context);
			await use(audit);
			expect(await audit.violations()).toEqual([]);
		},
		{ auto: true },
	],
	as: async ({ browser, audit, state }, use) => {
		const sessions: Session[] = [];
		await use(async (name) => {
			const s = await newSession(browser, audit, state.users[name]);
			sessions.push(s);
			return s;
		});
		for (const s of sessions) await s.context.close();
	},
});

/** Creates a sandbox through the form and waits until the page says ready. */
export async function createSandbox(
	page: Page,
	teamId: string,
	o: {
		slug: string;
		env?: Record<string, string>;
		secrets?: Record<string, string>;
	},
): Promise<string> {
	await page.goto(`/app/t/${teamId}/sandboxes/new`);
	await page.getByRole("textbox", { name: "Slug" }).fill(o.slug);
	let i = 1;
	for (const [k, v] of Object.entries(o.env ?? {})) {
		if (i > 1) await page.getByRole("button", { name: "Add" }).nth(1).click();
		await page.getByRole("textbox", { name: `Env var ${i} name` }).fill(k);
		await page.getByRole("textbox", { name: `Env var ${i} value` }).fill(v);
		i++;
	}
	i = 1;
	for (const [k, v] of Object.entries(o.secrets ?? {})) {
		if (i > 1) await page.getByRole("button", { name: "Add" }).nth(2).click();
		await page.getByRole("textbox", { name: `Secret ${i} name` }).fill(k);
		await page.getByRole("textbox", { name: `Secret ${i} value` }).fill(v);
		i++;
	}
	await page.getByRole("button", { name: "Create" }).click();
	await page.waitForURL(new RegExp(`/sandboxes/${o.slug}`));
	await expect(state(page)).toHaveText("ready", { timeout: 90_000 });
	const id = await page
		.getByRole("term")
		.filter({ hasText: /^ID$/ })
		.locator("xpath=following-sibling::dd[1]")
		.textContent();
	if (!id?.startsWith("sb_")) throw new Error(`no sandbox id: ${id}`);
	return id;
}

/** The State value of the sandbox page header. */
export function state(page: Page) {
	return page
		.getByRole("term")
		.filter({ hasText: /^State$/ })
		.locator("xpath=following-sibling::dd[1]");
}

/** Opens a tab of the sandbox page and returns its panel. */
export async function openTab(page: Page, name: string) {
	await page.getByRole("tab", { name, exact: true }).click();
	return page.getByRole("tabpanel", { name });
}

/** Text of the n-th xterm on the page (DOM renderer rows). */
export function xtermText(page: Page, n = 0): Promise<string> {
	return (
		page
			.getByTestId("xterm")
			.nth(n)
			// biome-ignore lint/performance/useDomNodeTextContent: rows as rendered lines
			.evaluate((el) => (el as HTMLElement).innerText)
	);
}

/**
 * The id (`next-action` header) and body of the next server action request
 * the page sends: the specs replay actions with other arguments or as
 * another user (S8 Review Focus 2).
 */
export async function captureAction(
	page: Page,
	trigger: () => Promise<void>,
): Promise<{ id: string; url: string; body: string }> {
	const req = page.waitForRequest(
		(r) => r.method() === "POST" && r.headers()["next-action"] !== undefined,
	);
	await trigger();
	const r = await req;
	return {
		id: r.headers()["next-action"] as string,
		url: r.url(),
		body: r.postData() ?? "",
	};
}

/** Calls a server action by id with JSON arguments; the RSC answer as text. */
export async function callAction(
	request: APIRequestContext,
	action: { id: string; url: string },
	args: unknown[],
	origin = APP,
): Promise<{ status: number; text: string }> {
	const r = await request.post(action.url, {
		headers: {
			"next-action": action.id,
			accept: "text/x-component",
			"content-type": "text/plain;charset=UTF-8",
			origin,
		},
		data: JSON.stringify(args),
	});
	return { status: r.status(), text: await r.text() };
}

/**
 * Resolves with the next PTY WebSocket of the page once the server sent
 * `attached` (input typed before that could be lost). Call before the
 * action that opens it.
 */
export async function attachedPty(page: Page): Promise<WebSocket> {
	const ws = await page.waitForEvent("websocket", {
		predicate: (w) => w.url().includes("/ptys/"),
	});
	await ws.waitForEvent("framereceived", {
		predicate: (f) => String(f.payload).includes('"attached"'),
	});
	return ws;
}

/**
 * The sandbox `slug` of the team (created through the form if missing),
 * ready, with the page on it; returns its id.
 */
export async function ensureSandbox(
	s: Session,
	teamId: string,
	slug: string,
): Promise<string> {
	const r = await s.request.get(`/api/v1/sandboxes/${slug}?team=${teamId}`);
	if (r.status() === 404) return createSandbox(s.page, teamId, { slug });
	expect(r.status()).toBe(200);
	await s.page.goto(`/app/t/${teamId}/sandboxes/${slug}`);
	await expect(state(s.page)).toHaveText("ready", { timeout: 90_000 });
	return ((await r.json()) as { id: string }).id;
}

/** The personal team of a signed-in user (where sign-in lands). */
export async function personalTeam(s: Session): Promise<string> {
	await s.page.goto("/app");
	await s.page.waitForURL(/\/app\/t\/team_/);
	return teamOf(s.page);
}

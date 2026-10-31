// Calls to the public API listener of the e2e backend with a team API key
// (what an agent or CI does), for the key scenarios.
import { PUBLIC_API } from "./env.ts";

export function bearer(secret: string): Record<string, string> {
	return { authorization: `Bearer ${secret}` };
}

export async function me(secret: string): Promise<number> {
	return (await fetch(`${PUBLIC_API}/v1/me`, { headers: bearer(secret) }))
		.status;
}

/** NDJSON frames of a streaming command, as they arrive. */
export class CommandStream {
	readonly frames: Record<string, unknown>[] = [];
	readonly done: Promise<void>;

	constructor(secret: string, sandboxId: string, command: string) {
		this.done = (async () => {
			const r = await fetch(
				`${PUBLIC_API}/v1/sandboxes/${sandboxId}/commands`,
				{
					method: "POST",
					headers: { ...bearer(secret), "content-type": "application/json" },
					body: JSON.stringify({ command, mode: "stream" }),
				},
			);
			if (!r.ok || r.body === null) {
				throw new Error(`stream: ${r.status} ${await r.text()}`);
			}
			const dec = new TextDecoder();
			let buf = "";
			for await (const chunk of r.body) {
				buf += dec.decode(chunk as Uint8Array, { stream: true });
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line !== "") this.frames.push(JSON.parse(line));
					nl = buf.indexOf("\n");
				}
			}
		})();
		this.done.catch(() => {});
	}
}

/** A PTY of the sandbox over the public listener, with its close code. */
export async function openKeyPty(
	secret: string,
	sandboxId: string,
): Promise<{
	ws: WebSocket;
	closed: Promise<number>;
	attached: Promise<void>;
}> {
	const r = await fetch(`${PUBLIC_API}/v1/sandboxes/${sandboxId}/ptys`, {
		method: "POST",
		headers: { ...bearer(secret), "content-type": "application/json" },
		body: "{}",
	});
	if (!r.ok) throw new Error(`pty: ${r.status} ${await r.text()}`);
	const { id } = (await r.json()) as { id: string };
	const url = `${PUBLIC_API.replace(/^http/, "ws")}/v1/sandboxes/${sandboxId}/ptys/${id}/connect`;
	// Node's WebSocket (undici) takes request headers in its init object.
	const ws = new WebSocket(url, {
		protocols: ["sbx.pty.v1"],
		headers: bearer(secret),
	} as unknown as string[]);
	const closed = new Promise<number>((res) =>
		ws.addEventListener("close", (e) => res(e.code)),
	);
	const attached = new Promise<void>((res, rej) => {
		ws.addEventListener("message", (e) => {
			if (typeof e.data === "string" && e.data.includes('"attached"')) res();
		});
		ws.addEventListener("close", (e) => rej(new Error(`closed ${e.code}`)));
	});
	attached.catch(() => {});
	return { ws, closed, attached };
}

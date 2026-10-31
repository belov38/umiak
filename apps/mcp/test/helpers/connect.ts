// In-memory MCP client for tests. The server side goes through `serveStdio`
// with an in-memory transport, so the era is chosen by the opening exchange
// exactly as on a real stdio connection: a client pinned to 2026-07-28 gets
// the modern era (per-request envelope, cache fields), a default client the
// legacy 2025-11-25 `initialize` handshake.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export type Era = "modern" | "legacy";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const TEST_CLIENT_INFO = { name: "test-client", version: "9.9.9" };

export interface InMemoryConnection {
	client: Client;
	/** Out-of-band errors the server side reported (never written to the wire). */
	errors: Error[];
	close(): Promise<void>;
}

/**
 * Connects a client to `server` (or to a server built per connection by a
 * factory). A server instance serves one connection only.
 */
export async function connectInMemory(
	server: McpServer | (() => McpServer),
	opts: { era?: Era } = {},
): Promise<InMemoryConnection> {
	const era = opts.era ?? "modern";
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const errors: Error[] = [];
	const handle = serveStdio(
		typeof server === "function" ? server : () => server,
		{
			transport: serverSide,
			onerror: (err) => errors.push(err),
		},
	);
	const client = new Client(
		TEST_CLIENT_INFO,
		era === "modern"
			? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
			: {},
	);
	try {
		await client.connect(clientSide);
	} catch (err) {
		await handle.close();
		throw err;
	}
	return {
		client,
		errors,
		async close() {
			await client.close();
			await handle.close();
		},
	};
}

// Minimal stdio MCP server used by the Bun compile spike: one `ping` tool.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(
	() => {
		const server = new McpServer(
			{ name: "spike", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		server.registerTool(
			"ping",
			{
				description: "Replies with pong.",
				inputSchema: z.object({}),
			},
			async () => ({ content: [{ type: "text", text: "pong" }] }),
		);
		return server;
	},
	{ legacy: "serve" },
);

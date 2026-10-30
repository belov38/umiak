// Hosted ports (S7 §11.2, S4 §8). The port token is only in the answer of
// the call that issued it; GET never returns it.
import { z } from "@hono/zod-openapi";
import {
	PORT_APP_PROTOCOLS,
	PORT_HOST_REWRITES,
	PORT_MODES,
	RESERVED_PORTS,
} from "@sbx/core";
import { extensibleEnum } from "../openapi/registry.ts";
import { Timestamp } from "./common.ts";

const ACCESS = PORT_MODES as readonly ["token", "sso", "public"];
const HOST_REWRITES = PORT_HOST_REWRITES as readonly ["preserve", "localhost"];
const APP_PROTOCOLS = PORT_APP_PROTOCOLS as readonly ["http1", "h2c"];

/** The ports nobody may host, as text for descriptions ("22, 47800, ..."). */
export const RESERVED_PORTS_TEXT = RESERVED_PORTS.join(", ");

export const PortParams = z.object({
	sandbox: z.string().openapi({
		param: { name: "sandbox", in: "path" },
		description: "Sandbox id (`sb_...`) or slug",
		example: "quiet-otter-lamp",
	}),
	port: z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.openapi({
			param: { name: "port", in: "path" },
			description: `TCP port in the guest, 1-65535; not ${RESERVED_PORTS_TEXT} (platform)`,
			example: 3000,
		}),
});

export const HostPortRequest = z
	.strictObject({
		access: z
			.enum(ACCESS)
			.optional()
			.openapi({
				description:
					"token (default): a secret link; sso: any signed-in user of the platform; " +
					"public: anyone (the operator may turn public off)",
			}),
		hostRewrite: z
			.enum(HOST_REWRITES)
			.optional()
			.openapi({
				description:
					"preserve (default): the app sees the public Host; localhost: Host is rewritten " +
					"to localhost:<port> for dev servers that check it",
			}),
		appProtocol: z.enum(APP_PROTOCOLS).optional().openapi({
			description: "http1 (default) or h2c (HTTP/2 without TLS, gRPC)",
		}),
	})
	.openapi("HostPortRequest", {
		description:
			"The full desired settings (PUT): an omitted field takes its default, not the current value",
	});

const hostedPortFields = {
	port: z.int().openapi({ example: 3000 }),
	label: z.string().openapi({
		description: "`<slug>-<port>`, the first DNS label of the URL",
		example: "quiet-otter-lamp-3000",
	}),
	url: z.string().openapi({
		example: "https://quiet-otter-lamp-3000.sbx.example.com",
	}),
	access: extensibleEnum(ACCESS),
	hostRewrite: extensibleEnum(HOST_REWRITES),
	appProtocol: extensibleEnum(APP_PROTOCOLS),
	blocked: z.boolean().openapi({
		description: "An operator blocked the port; the gateway refuses it",
	}),
	blockReason: z.string().nullable(),
	createdAt: Timestamp,
};

export const HostedPortSchema = z
	.object(hostedPortFields)
	.openapi("HostedPort", { description: "A port published by the gateway" });

export const HostedPortWriteSchema = z
	.object({
		...hostedPortFields,
		token: z
			.string()
			.optional()
			.openapi({
				description:
					"Only when this call issued a token (a new token port or a switch to token). " +
					"It is not stored and never shown again: replace a lost one with rotate-token",
				example: "sbxp_...",
			}),
		urlWithToken: z.string().optional().openapi({
			description: "`url` + `/?_token=<token>`, with `token`",
		}),
	})
	.openapi("HostedPortWrite", {
		description: "The hosted port; with the token when this call issued one",
	});

export const ListeningPortSchema = z
	.object({
		port: z.int(),
		addresses: z.array(z.string()),
		process: z.string(),
		user: z.string(),
	})
	.openapi("ListeningPort", {
		description: "A TCP port a process in the guest listens on",
	});

export const SandboxPortsSchema = z
	.object({
		hosted: z.array(HostedPortSchema),
		listening: z.array(ListeningPortSchema),
		listeningObservedAt: Timestamp.nullable().openapi({
			description:
				"When `listening` was read from the agent; null when it is the last report " +
				"stored for the sandbox (not ready or the agent is unreachable)",
		}),
	})
	.openapi("SandboxPorts");

export const PortTokenSchema = z
	.object({
		token: z.string().openapi({ example: "sbxp_..." }),
		urlWithToken: z.string(),
	})
	.openapi("PortToken", {
		description: "The new token; the old token and its cookies stopped working",
	});

// SSH access of a sandbox (S7 §11.3, S4 §9.2): how to connect and
// short-lived OpenSSH user certificates signed by the SSH login CA
// (principal = sandbox id, KeyId = the caller). The state of the sandbox is
// not checked: the gateway explains a stopped sandbox itself. Whether the
// caller may still log in is decided by `ssh/authorize` on every connection.
import { createRoute } from "@hono/zod-openapi";
import {
	encodeUuid,
	parseSshPublicKey,
	SshKeyError,
	type SshPublicKey,
	signUserCertificate,
} from "@sbx/auth";
import type { Sandbox } from "@sbx/core";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import { SandboxParams } from "../schemas/common.ts";
import {
	SshAccessSchema,
	SshCertificateRequest,
	SshCertificateSchema,
} from "../schemas/ssh.ts";

const TAGS = ["ssh"];

/** S7 §11.3: login certificates start 60 s back (clock skew) and last 10 min. */
const CERT_BACKDATE_MS = 60_000;
export const CERT_LIFETIME_MS = 10 * 60_000;

const DEFAULT_LOGIN_USER = "user";

const notFound404 = errorResponse("`not_found`: no such sandbox in the team");

/** The public key of a request, or 400 validation at `path`. */
export function parsePublicKeyField(
	line: string,
	path = "publicKey",
): SshPublicKey {
	try {
		return parseSshPublicKey(line);
	} catch (e) {
		if (e instanceof SshKeyError) {
			throw validationError([{ path, message: e.message }]);
		}
		throw e;
	}
}

const getSsh = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/ssh",
	operationId: "ssh.get",
	summary: "How to connect over SSH",
	description:
		"Host, port and user name (the slug) of the SSH gateway, the guest user of the session, " +
		"a ready `ssh` command and `known_hosts` lines for the gateway's host keys. `hasKeys` " +
		"says whether the person registered SSH keys (POST /v1/ssh-keys); without them, or " +
		"with a team key, get a certificate (POST .../ssh/certificate).",
	tags: TAGS,
	middleware: [requireScope("ssh:connect")] as const,
	request: { params: SandboxParams },
	responses: {
		200: jsonResponse(SshAccessSchema, "How to connect"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const certify = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ssh/certificate",
	operationId: "ssh.certificate",
	summary: "Get a short-lived SSH certificate",
	description:
		"Signs the public key with the platform's SSH login CA: an OpenSSH user certificate " +
		"for this sandbox only, valid 10 minutes (checked when logging in; the session may " +
		"last longer), with the caller as KeyId. Works for people and team keys; the " +
		"sandbox may be in any state. Every login is still checked, so revoking a key or " +
		"leaving the team takes effect at once.",
	tags: TAGS,
	middleware: [requireScope("ssh:connect")] as const,
	request: {
		params: SandboxParams,
		body: jsonBody(SshCertificateRequest, "The public key to certify"),
	},
	responses: {
		200: jsonResponse(SshCertificateSchema, "The certificate"),
		400: errorResponse(
			"`validation`: not a supported public key (ed25519, ecdsa, RSA >= 3072 bits; no certificates)",
		),
		404: notFound404,
		500: errorResponse("`internal`: the SSH login CA is not configured"),
		...ERROR_RESPONSES,
	},
});

interface Connect {
	host: string;
	port: number;
	username: string;
	knownHosts: string[];
}

function connectInfo(deps: ApiDeps, s: Sandbox): Connect {
	const { sshHost: host, sshPort: port } = deps.settings;
	// known_hosts names a non-standard port as `[host]:port`.
	const name = port === 22 ? host : `[${host}]:${port}`;
	return {
		host,
		port,
		username: s.slug,
		knownHosts: deps.hostKeys.map((k) => `${name} ${k}`),
	};
}

function sshCommand(c: Connect): string {
	const port = c.port === 22 ? "" : `-p ${c.port} `;
	return `ssh ${port}${c.username}@${c.host}`;
}

/** Whole seconds: what the certificate carries. */
function floorSeconds(ms: number): Date {
	return new Date(Math.floor(ms / 1000) * 1000);
}

export function registerSshRoutes(app: ApiApp, deps: ApiDeps): void {
	const svc = deps.svc;

	app.openapi(getSsh, async (c) => {
		const a = authOf(c);
		const s = await svc.get(
			a.principal,
			resolveSandboxRef(c.req.valid("param").sandbox),
		);
		const template = await deps.config.template(s.templateSlug);
		const hasKeys =
			a.principal.userId === null
				? false
				: (await deps.identity.listSshKeys(a.principal.userId)).length > 0;
		const info = connectInfo(deps, s);
		return c.json(
			{
				...info,
				loginUser: template?.loginUser ?? DEFAULT_LOGIN_USER,
				command: sshCommand(info),
				hasKeys,
			},
			200,
		);
	});

	app.openapi(certify, async (c) => {
		const p = authOf(c).principal;
		const s = await svc.get(p, resolveSandboxRef(c.req.valid("param").sandbox));
		const { publicKey } = c.req.valid("json");
		parsePublicKeyField(publicKey);
		const ca = deps.sshCa;
		if (ca === null) {
			throw new ApiError(500, "internal", "SSH login CA is not configured");
		}
		const keyId =
			p.kind === "team_key"
				? `sbx:key:${encodeUuid("apiKey", p.apiKeyId as string)}`
				: `sbx:user:${encodeUuid("user", p.userId as string)}`;
		const principal = encodeUuid("sandbox", s.id);
		const now = Date.now();
		const validAfter = floorSeconds(now - CERT_BACKDATE_MS);
		const validBefore = floorSeconds(now + CERT_LIFETIME_MS);
		const { certificate } = signUserCertificate(ca, {
			publicKey,
			keyId,
			principals: [principal],
			validAfter,
			validBefore,
		});
		return c.json(
			{
				certificate,
				principal,
				validAfter: validAfter.toISOString(),
				validBefore: validBefore.toISOString(),
				...connectInfo(deps, s),
			},
			200,
		);
	});
}

// Every operation of the public document (`openapi/v1.json`) with its
// access rule (S7 §6 scope column, §7.2, §7.3, §7.5) and an example request
// over a fixture of one team. The security matrices (security-*.test.ts)
// iterate over it; a test checks that it lists exactly the operations of
// the document, so a new operation fails until it is added here.
import type { Scope } from "@sbx/auth";
import { ed25519PublicKey } from "./ssh.ts";

/** Resources a request names, in its path or body (IDOR matrix). */
export type Resource =
	| "sandbox"
	| "command"
	| "pty"
	| "upload"
	| "operation"
	| "snapshot"
	| "port"
	| "environment"
	| "sshKey"
	| "apiKey";

/** Resources of one team, as the API names them. */
export interface Fixture {
	/** Team uuid. */
	teamId: string;
	/** `sb_...` of a ready sandbox. */
	sandbox: string;
	/** `cmd_...` of a running detached command with stdin. */
	command: string;
	/** `cmd_...` of a running PTY. */
	pty: string;
	/** `upl_...` of an upload with some bytes. */
	upload: string;
	/** Bytes received by that upload. */
	uploadOffset: number;
	/** `op_...` of a finished operation of the sandbox. */
	operation: string;
	/** Name of a saved snapshot. */
	snapshot: string;
	/** A published port of the sandbox. */
	port: number;
	/** `env_...` of an environment, and its name. */
	environment: string;
	environmentName: string;
	/** `sshk_...` of an SSH key of a person of the team. */
	sshKey: string;
	/** `key_...` of a team key nobody uses. */
	apiKey: string;
}

export interface RouteRequest {
	path: string;
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
}

export interface Route {
	method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path template of the document. */
	path: string;
	/** Scope a team key needs; null when any key will do. */
	scope: Scope | null;
	/** No credential needed (`security: []`). */
	anonymous?: true;
	/** A person only: a team key gets 403 `user_required` (`HUMAN_ONLY`). */
	human?: true;
	/** A person needs the owner role: a member gets 403 `role`. */
	owner?: true;
	/** A team key only: a person gets 403 `api_key_required`. */
	keyOnly?: true;
	/** A WebSocket upgrade (`app.request` answers 426 past the guards). */
	websocket?: true;
	/** Changes or consumes a resource of the fixture. */
	destructive?: true;
	/** Resources the request names (path and body). */
	resources: Resource[];
	/** Scopes the body can add: `[scope, request that needs it]`. */
	bodyScopes?: (f: Fixture) => [Scope, RouteRequest][];
	/** Requests naming resources only in the body (IDOR matrix). */
	bodyRefs?: (f: Fixture) => RouteRequest[];
	/** The example request over the fixture. */
	request(f: Fixture): RouteRequest;
}

const sb = (f: Fixture) => `/v1/sandboxes/${f.sandbox}`;
const cmd = (f: Fixture) => `${sb(f)}/commands/${f.command}`;
const pty = (f: Fixture) => `${sb(f)}/ptys/${f.pty}`;
const upl = (f: Fixture) => `${sb(f)}/files/uploads/${f.upload}`;
const octet = (data: string): Partial<RouteRequest> => ({
	body: data,
	headers: { "content-type": "application/octet-stream" },
});
let seq = 0;
/** A name nobody has used yet. */
export const fresh = (prefix: string) =>
	`${prefix}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export const ROUTES: Record<string, Route> = {
	// --- meta and account ---
	"meta.get": {
		method: "GET",
		path: "/v1/meta",
		scope: null,
		anonymous: true,
		resources: [],
		request: () => ({ path: "/v1/meta" }),
	},
	"meta.openapi": {
		method: "GET",
		path: "/v1/openapi.json",
		scope: null,
		anonymous: true,
		resources: [],
		request: () => ({ path: "/v1/openapi.json" }),
	},
	"meta.docs": {
		method: "GET",
		path: "/v1/docs",
		scope: null,
		anonymous: true,
		resources: [],
		request: () => ({ path: "/v1/docs" }),
	},
	"me.get": {
		method: "GET",
		path: "/v1/me",
		scope: null,
		resources: [],
		request: () => ({ path: "/v1/me" }),
	},
	"limits.get": {
		method: "GET",
		path: "/v1/limits",
		scope: null,
		resources: [],
		request: () => ({ path: "/v1/limits" }),
	},
	"templates.list": {
		method: "GET",
		path: "/v1/templates",
		scope: null,
		resources: [],
		request: () => ({ path: "/v1/templates" }),
	},
	"sizes.list": {
		method: "GET",
		path: "/v1/sizes",
		scope: null,
		resources: [],
		request: () => ({ path: "/v1/sizes" }),
	},

	// --- team API keys ---
	"apiKeys.list": {
		method: "GET",
		path: "/v1/api-keys",
		scope: "keys:admin",
		resources: [],
		request: () => ({ path: "/v1/api-keys" }),
	},
	"apiKeys.create": {
		method: "POST",
		path: "/v1/api-keys",
		scope: null,
		human: true,
		owner: true,
		resources: [],
		request: () => ({
			path: "/v1/api-keys",
			json: { name: fresh("key"), preset: "read-only" },
		}),
	},
	"apiKeys.revokeSelf": {
		method: "DELETE",
		path: "/v1/api-keys/self",
		scope: null,
		keyOnly: true,
		destructive: true,
		resources: [],
		request: () => ({ path: "/v1/api-keys/self" }),
	},
	"apiKeys.revoke": {
		method: "DELETE",
		path: "/v1/api-keys/{key}",
		scope: "keys:admin",
		owner: true,
		destructive: true,
		resources: ["apiKey"],
		request: (f) => ({ path: `/v1/api-keys/${f.apiKey}` }),
	},
	"apiKeys.rotate": {
		method: "POST",
		path: "/v1/api-keys/{key}/rotate",
		scope: null,
		human: true,
		owner: true,
		destructive: true,
		resources: ["apiKey"],
		request: (f) => ({ path: `/v1/api-keys/${f.apiKey}/rotate` }),
	},

	// --- SSH keys of a person ---
	"sshKeys.list": {
		method: "GET",
		path: "/v1/ssh-keys",
		scope: "ssh:connect",
		human: true,
		resources: [],
		request: () => ({ path: "/v1/ssh-keys" }),
	},
	"sshKeys.create": {
		method: "POST",
		path: "/v1/ssh-keys",
		scope: "ssh:connect",
		human: true,
		resources: [],
		request: () => ({
			path: "/v1/ssh-keys",
			json: { name: fresh("ssh"), publicKey: ed25519PublicKey() },
		}),
	},
	"sshKeys.delete": {
		method: "DELETE",
		path: "/v1/ssh-keys/{key}",
		scope: "ssh:connect",
		human: true,
		destructive: true,
		resources: ["sshKey"],
		request: (f) => ({ path: `/v1/ssh-keys/${f.sshKey}` }),
	},

	// --- environments ---
	"environments.list": {
		method: "GET",
		path: "/v1/environments",
		scope: "environments:read",
		resources: [],
		request: () => ({ path: "/v1/environments" }),
	},
	"environments.create": {
		method: "POST",
		path: "/v1/environments",
		scope: "environments:write",
		owner: true,
		resources: [],
		request: () => ({
			path: "/v1/environments",
			json: { name: fresh("env"), env: { E: "1" } },
		}),
	},
	"environments.get": {
		method: "GET",
		path: "/v1/environments/{environment}",
		scope: "environments:read",
		resources: ["environment"],
		request: (f) => ({ path: `/v1/environments/${f.environment}` }),
	},
	"environments.update": {
		method: "PATCH",
		path: "/v1/environments/{environment}",
		scope: "environments:write",
		owner: true,
		resources: ["environment"],
		request: (f) => ({
			path: `/v1/environments/${f.environment}`,
			json: { env: { E: "2" } },
		}),
	},
	"environments.delete": {
		method: "DELETE",
		path: "/v1/environments/{environment}",
		scope: "environments:write",
		owner: true,
		destructive: true,
		resources: ["environment"],
		request: (f) => ({ path: `/v1/environments/${f.environment}` }),
	},

	// --- snapshots ---
	"snapshots.list": {
		method: "GET",
		path: "/v1/snapshots",
		scope: "snapshots:read",
		resources: [],
		request: () => ({ path: "/v1/snapshots" }),
	},
	"snapshots.create": {
		method: "POST",
		path: "/v1/snapshots",
		scope: "snapshots:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({
			path: "/v1/snapshots",
			json: { sandbox: f.sandbox, name: fresh("snap") },
		}),
	},
	"snapshots.get": {
		method: "GET",
		path: "/v1/snapshots/{name}",
		scope: "snapshots:read",
		resources: ["snapshot"],
		request: (f) => ({ path: `/v1/snapshots/${f.snapshot}` }),
	},
	"snapshots.delete": {
		method: "DELETE",
		path: "/v1/snapshots/{name}",
		scope: "snapshots:write",
		destructive: true,
		resources: ["snapshot"],
		request: (f) => ({
			path: `/v1/snapshots/${f.snapshot}`,
			headers: { "sbx-confirm-delete": f.snapshot },
		}),
	},

	// --- sandboxes and operations ---
	"sandboxes.list": {
		method: "GET",
		path: "/v1/sandboxes",
		scope: "sandboxes:read",
		resources: [],
		request: () => ({ path: "/v1/sandboxes" }),
	},
	"sandboxes.create": {
		method: "POST",
		path: "/v1/sandboxes",
		scope: "sandboxes:write",
		resources: ["snapshot", "environment"],
		bodyScopes: (f) => [
			[
				"snapshots:read",
				{ path: "/v1/sandboxes", json: { from: { snapshot: f.snapshot } } },
			],
			[
				"environments:read",
				{ path: "/v1/sandboxes", json: { environment: f.environment } },
			],
		],
		bodyRefs: (f) => [
			{ path: "/v1/sandboxes", json: { from: { snapshot: f.snapshot } } },
			{ path: "/v1/sandboxes", json: { environment: f.environment } },
			{ path: "/v1/sandboxes", json: { environment: f.environmentName } },
		],
		request: () => ({ path: "/v1/sandboxes", json: {} }),
	},
	"sandboxes.get": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}",
		scope: "sandboxes:read",
		resources: ["sandbox"],
		request: (f) => ({ path: sb(f) }),
	},
	"sandboxes.update": {
		method: "PATCH",
		path: "/v1/sandboxes/{sandbox}",
		scope: "sandboxes:write",
		resources: ["sandbox"],
		request: (f) => ({ path: sb(f), json: { name: "renamed" } }),
	},
	"sandboxes.delete": {
		method: "DELETE",
		path: "/v1/sandboxes/{sandbox}",
		scope: "sandboxes:delete",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({
			path: sb(f),
			headers: { "sbx-confirm-delete": f.sandbox },
		}),
	},
	"sandboxes.stop": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/stop",
		scope: "sandboxes:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/stop` }),
	},
	"sandboxes.resume": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/resume",
		scope: "sandboxes:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/resume`, json: {} }),
	},
	"sandboxes.fork": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/fork",
		scope: "sandboxes:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/fork`, json: {} }),
	},
	"sandboxes.recover": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/recover",
		scope: "sandboxes:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/recover` }),
	},
	"sandboxes.extend": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/extend",
		scope: "sandboxes:write",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/extend`, json: { ttlSeconds: 3600 } }),
	},
	"sandboxes.getEnv": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/env",
		scope: "sandboxes:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/env` }),
	},
	"sandboxes.replaceEnv": {
		method: "PUT",
		path: "/v1/sandboxes/{sandbox}/env",
		scope: "sandboxes:write",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/env`, json: { env: { R: "1" } } }),
	},
	"sandboxes.patchEnv": {
		method: "PATCH",
		path: "/v1/sandboxes/{sandbox}/env",
		scope: "sandboxes:write",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/env`, json: { env: { P: "1" } } }),
	},
	"operations.get": {
		method: "GET",
		path: "/v1/operations/{operation}",
		scope: "sandboxes:read",
		resources: ["operation"],
		request: (f) => ({ path: `/v1/operations/${f.operation}` }),
	},

	// --- commands and terminals ---
	"commands.create": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/commands",
		scope: "commands:exec",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/commands`,
			json: { command: "true", mode: "detached" },
		}),
	},
	"commands.list": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/commands",
		scope: "commands:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/commands` }),
	},
	"commands.get": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/commands/{command}",
		scope: "commands:read",
		resources: ["sandbox", "command"],
		request: (f) => ({ path: cmd(f) }),
	},
	"commands.stream": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/commands/{command}/stream",
		scope: "commands:read",
		resources: ["sandbox", "command"],
		request: (f) => ({ path: `${cmd(f)}/stream?follow=false` }),
	},
	"commands.output": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/commands/{command}/output",
		scope: "commands:read",
		resources: ["sandbox", "command"],
		request: (f) => ({ path: `${cmd(f)}/output` }),
	},
	"commands.input": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/commands/{command}/input",
		scope: "commands:exec",
		resources: ["sandbox", "command"],
		request: (f) => ({ path: `${cmd(f)}/input`, json: { data: "x\n" } }),
	},
	"commands.kill": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/commands/{command}/kill",
		scope: "commands:exec",
		destructive: true,
		resources: ["sandbox", "command"],
		request: (f) => ({ path: `${cmd(f)}/kill`, json: {} }),
	},
	"commands.signal": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/commands/{command}/signal",
		scope: "commands:exec",
		destructive: true,
		resources: ["sandbox", "command"],
		request: (f) => ({
			path: `${cmd(f)}/signal`,
			json: { signal: "SIGTERM" },
		}),
	},
	"ptys.create": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/ptys",
		scope: "commands:exec",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/ptys`, json: { command: "cat" } }),
	},
	"ptys.connect": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/ptys/{command}/connect",
		scope: "commands:exec",
		websocket: true,
		resources: ["sandbox", "pty"],
		request: (f) => ({ path: `${pty(f)}/connect` }),
	},
	"ptys.resize": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/ptys/{command}/resize",
		scope: "commands:exec",
		resources: ["sandbox", "pty"],
		request: (f) => ({
			path: `${pty(f)}/resize`,
			json: { cols: 100, rows: 30 },
		}),
	},

	// --- files ---
	"files.download": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/files/content",
		scope: "files:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files/content?path=~/f.txt` }),
	},
	"files.downloadHead": {
		method: "HEAD",
		path: "/v1/sandboxes/{sandbox}/files/content",
		scope: "files:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files/content?path=~/f.txt` }),
	},
	"files.write": {
		method: "PUT",
		path: "/v1/sandboxes/{sandbox}/files/content",
		scope: "files:write",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/files/content?path=~/w.txt`,
			...octet("written"),
		}),
	},
	"files.stat": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/files/stat",
		scope: "files:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files/stat?path=~/f.txt` }),
	},
	"files.list": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/files/list",
		scope: "files:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files/list?path=~` }),
	},
	"files.mkdir": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/files/mkdir",
		scope: "files:write",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/files/mkdir`,
			json: { path: "~/made", parents: true },
		}),
	},
	"files.move": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/files/move",
		scope: "files:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/files/move`,
			json: { from: "~/f.txt", to: "~/moved.txt" },
		}),
	},
	"files.chmod": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/files/chmod",
		scope: "files:write",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/files/chmod`,
			json: { path: "~/f.txt", mode: 0o644 },
		}),
	},
	"files.delete": {
		method: "DELETE",
		path: "/v1/sandboxes/{sandbox}/files",
		scope: "files:write",
		destructive: true,
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files?path=~/f.txt` }),
	},
	"files.downloadArchive": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/files/archive",
		scope: "files:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/files/archive?path=~` }),
	},
	"files.uploadArchive": {
		method: "PUT",
		path: "/v1/sandboxes/{sandbox}/files/archive",
		scope: "files:write",
		resources: ["sandbox"],
		// Two zero blocks: an empty tar archive.
		request: (f) => ({
			path: `${sb(f)}/files/archive?path=~/unpacked&makeParents=true`,
			body: new Uint8Array(1024),
			headers: { "content-type": "application/octet-stream" },
		}),
	},
	"files.createUpload": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/files/uploads",
		scope: "files:write",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/files/uploads`,
			json: { path: "~/up.bin" },
		}),
	},
	"files.putChunk": {
		method: "PUT",
		path: "/v1/sandboxes/{sandbox}/files/uploads/{upload}",
		scope: "files:write",
		resources: ["sandbox", "upload"],
		request: (f) => ({
			path: `${upl(f)}?offset=${f.uploadOffset}`,
			...octet("more"),
		}),
	},
	"files.uploadOffset": {
		method: "HEAD",
		path: "/v1/sandboxes/{sandbox}/files/uploads/{upload}",
		scope: "files:write",
		resources: ["sandbox", "upload"],
		request: (f) => ({ path: upl(f) }),
	},
	"files.deleteUpload": {
		method: "DELETE",
		path: "/v1/sandboxes/{sandbox}/files/uploads/{upload}",
		scope: "files:write",
		destructive: true,
		resources: ["sandbox", "upload"],
		request: (f) => ({ path: upl(f) }),
	},
	"files.commitUpload": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/files/uploads/{upload}/commit",
		scope: "files:write",
		destructive: true,
		resources: ["sandbox", "upload"],
		request: (f) => ({
			path: `${upl(f)}/commit`,
			json: { path: "~/committed.bin" },
		}),
	},

	// --- ports and SSH ---
	"ports.list": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/ports",
		scope: "sandboxes:read",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/ports` }),
	},
	"ports.put": {
		method: "PUT",
		path: "/v1/sandboxes/{sandbox}/ports/{port}",
		scope: "ports:write",
		resources: ["sandbox", "port"],
		request: (f) => ({
			path: `${sb(f)}/ports/${f.port}`,
			json: { access: "token" },
		}),
	},
	"ports.rotateToken": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/ports/{port}/rotate-token",
		scope: "ports:write",
		resources: ["sandbox", "port"],
		request: (f) => ({ path: `${sb(f)}/ports/${f.port}/rotate-token` }),
	},
	"ports.delete": {
		method: "DELETE",
		path: "/v1/sandboxes/{sandbox}/ports/{port}",
		scope: "ports:write",
		destructive: true,
		resources: ["sandbox", "port"],
		request: (f) => ({ path: `${sb(f)}/ports/${f.port}` }),
	},
	"ssh.get": {
		method: "GET",
		path: "/v1/sandboxes/{sandbox}/ssh",
		scope: "ssh:connect",
		resources: ["sandbox"],
		request: (f) => ({ path: `${sb(f)}/ssh` }),
	},
	"ssh.certificate": {
		method: "POST",
		path: "/v1/sandboxes/{sandbox}/ssh/certificate",
		scope: "ssh:connect",
		resources: ["sandbox"],
		request: (f) => ({
			path: `${sb(f)}/ssh/certificate`,
			json: { publicKey: ed25519PublicKey() },
		}),
	},
};

/** `[operationId, route]` pairs in table order. */
export const ROUTE_LIST: [string, Route][] = Object.entries(ROUTES);

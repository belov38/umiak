// POST /internal/v1/gateway/ssh/authorize (S7 §12.1, S4 §9.2, §9.5, S8 C6):
// who may log in to a sandbox over SSH, asked on every connection.
//   - a registered key: the stored key of the fingerprint equals publicKey;
//   - a login certificate the gateway verified: principal = the sandbox id,
//     KeyId `umiak:user:<usr_>` or `umiak:key:<key_>`, validBefore not passed.
// A person must be active and a member of the sandbox's team (no operator
// exception, C6); a team key must be live, of that team, with ssh:connect.
// `recheck` (the gateway re-checks open sessions after its LISTEN came back)
// checks the identity the same way but not the certificate's validity, and
// touches nothing. A team key's certificate issued before the key's last
// rotation is denied on login and on recheck. A sandbox blocked by an
// operator (S8 C3) is denied for everyone. A denial has no reason: the
// gateway does not show one.
import {
	decodeUuid,
	encodeUuid,
	parseSshPublicKey,
	type UserRecord,
} from "@umiak/auth";
import { isUuid, type SshTarget, sshTarget } from "@umiak/core";
import { z } from "zod";
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { validationError } from "../../http/errors.ts";
import { CERT_LIFETIME_MS } from "../ssh.ts";
import { poolOf, readJson, requireGateway } from "./common.ts";

const DEFAULT_LOGIN_USER = "user";

/** Clock skew allowed on validBefore (as the gateway's check, S4 §9.2). */
const CERT_SKEW_MS = 60_000;

/** lastUsedAt is written at most this often per key (S7 §12.1). */
const TOUCH_INTERVAL_MS = 60_000;

const AuthorizeRequest = z.object({
	sandbox: z.string().min(1),
	publicKey: z.string().optional(),
	fingerprint: z.string().optional(),
	certificate: z
		.object({
			keyId: z.string(),
			serial: z.string().optional(),
			principal: z.string(),
			validBefore: z.string().optional(),
		})
		.optional(),
	recheck: z.boolean().optional(),
});

type AuthorizeRequest = z.output<typeof AuthorizeRequest>;

type Actor =
	| { kind: "user"; userId: string; email: string }
	| { kind: "team_key"; apiKeyId: string };

const DENIED = { allowed: false } as const;

/** Exactly one credential: publicKey with fingerprint, or a certificate. */
function checkCredential(b: AuthorizeRequest): void {
	const key = b.publicKey !== undefined || b.fingerprint !== undefined;
	const cert = b.certificate !== undefined;
	if (key === cert) {
		throw validationError([
			{
				path: "",
				message: "send either publicKey with fingerprint or certificate",
			},
		]);
	}
	if (key && (b.publicKey === undefined || b.fingerprint === undefined)) {
		throw validationError([
			{
				path: b.publicKey === undefined ? "publicKey" : "fingerprint",
				message: "publicKey and fingerprint go together",
			},
		]);
	}
}

/** The sandbox by `sb_` id or slug; a bare UUID is not a reference here. */
async function target(deps: ApiDeps, ref: string): Promise<SshTarget | null> {
	if (ref.slice(0, 3).toLowerCase() === "sb_") {
		const id = decodeUuid("sandbox", ref);
		return id === null ? null : sshTarget(poolOf(deps), id);
	}
	if (isUuid(ref)) return null;
	return sshTarget(poolOf(deps), ref);
}

/** Key type and blob of an authorized_keys line, or null. */
function keyBlob(line: string): string | null {
	try {
		const k = parseSshPublicKey(line.trim());
		return `${k.type} ${k.blob.toString("base64")}`;
	} catch {
		return null;
	}
}

function due(lastUsedAt: Date | null): boolean {
	return (
		lastUsedAt === null ||
		Date.now() - lastUsedAt.getTime() >= TOUCH_INTERVAL_MS
	);
}

/**
 * Updates lastUsedAt; a failure is logged and does not refuse an otherwise
 * valid login (it is bookkeeping, not authorization).
 */
async function touch(
	deps: ApiDeps,
	what: string,
	id: string,
	fn: (id: string) => Promise<void>,
): Promise<void> {
	try {
		await fn(id);
	} catch (e) {
		deps.log.warn(
			{ id, err: e instanceof Error ? e.message : String(e) },
			`ssh authorize: lastUsedAt of the ${what} not updated`,
		);
	}
}

/** An active member of the team, or null. */
async function member(
	deps: ApiDeps,
	userId: string,
	teamId: string,
): Promise<UserRecord | null> {
	const u = await deps.identity.user(userId);
	if (u === null || !u.active) return null;
	return (await deps.identity.membership(userId, teamId)) === null ? null : u;
}

function userActor(u: UserRecord): Actor {
	return { kind: "user", userId: encodeUuid("user", u.id), email: u.email };
}

async function viaRegisteredKey(
	deps: ApiDeps,
	t: SshTarget,
	publicKey: string,
	fingerprint: string,
	recheck: boolean,
): Promise<Actor | null> {
	const stored = await deps.identity.findSshKeyByFingerprint(fingerprint);
	if (stored === null) return null;
	const sent = keyBlob(publicKey);
	if (sent === null || sent !== keyBlob(stored.publicKey)) return null;
	const u = await member(deps, stored.userId, t.teamId);
	if (u === null) return null;
	if (!recheck && due(stored.lastUsedAt)) {
		await touch(deps, "ssh key", stored.id, (id) =>
			deps.identity.touchSshKey(id),
		);
	}
	return userActor(u);
}

const KEY_ID_RE = /^umiak:(user|key):([^:]+)$/;

/**
 * A certificate of a team key issued before the key's last rotation (also
 * on recheck): the old secret no longer authorizes anything. It was issued
 * at validBefore − CERT_LIFETIME_MS (validBefore is floored to seconds, so
 * one issued within a second after the rotation is refused too; the client
 * gets a new one). Without a readable validBefore a rotated key's
 * certificate is refused.
 */
function issuedBeforeRotation(
	validBefore: string | undefined,
	rotatedAt: Date | null,
): boolean {
	if (rotatedAt === null) return false;
	const before = Date.parse(validBefore ?? "");
	if (Number.isNaN(before)) return true;
	return before - CERT_LIFETIME_MS < rotatedAt.getTime();
}

async function viaCertificate(
	deps: ApiDeps,
	t: SshTarget,
	cert: NonNullable<AuthorizeRequest["certificate"]>,
	recheck: boolean,
): Promise<Actor | null> {
	if (cert.principal !== encodeUuid("sandbox", t.sandboxId)) return null;
	if (!recheck) {
		const before = Date.parse(cert.validBefore ?? "");
		if (Number.isNaN(before) || before + CERT_SKEW_MS <= Date.now()) {
			return null;
		}
	}
	const m = KEY_ID_RE.exec(cert.keyId);
	if (m === null) return null;
	if (m[1] === "user") {
		const userId = decodeUuid("user", m[2]);
		if (userId === null) return null;
		const u = await member(deps, userId, t.teamId);
		return u === null ? null : userActor(u);
	}
	const keyId = decodeUuid("apiKey", m[2]);
	if (keyId === null) return null;
	const k = await deps.identity.apiKey(keyId);
	if (
		k === null ||
		k.teamId !== t.teamId ||
		k.revokedAt !== null ||
		k.expiresAt.getTime() <= Date.now() ||
		!k.scopes.includes("ssh:connect") ||
		issuedBeforeRotation(cert.validBefore, k.rotatedAt)
	) {
		return null;
	}
	if (!recheck && due(k.lastUsedAt)) {
		await touch(deps, "api key", k.id, (id) => deps.identity.touchApiKey(id));
	}
	return { kind: "team_key", apiKeyId: encodeUuid("apiKey", k.id) };
}

export function registerSshAuthorizeRoutes(app: ApiApp, deps: ApiDeps): void {
	app.post(
		"/internal/v1/gateway/ssh/authorize",
		requireGateway(),
		async (c) => {
			const b = await readJson(c, AuthorizeRequest);
			checkCredential(b);
			const recheck = b.recheck === true;
			const t = await target(deps, b.sandbox);
			// A blocked sandbox takes no SSH logins, operators included (S8 C3, C6).
			if (t === null || t.blocked) return c.json(DENIED, 200);
			const actor =
				b.certificate !== undefined
					? await viaCertificate(deps, t, b.certificate, recheck)
					: await viaRegisteredKey(
							deps,
							t,
							b.publicKey as string,
							b.fingerprint as string,
							recheck,
						);
			if (actor === null) return c.json(DENIED, 200);
			const template = await deps.config.template(t.templateSlug);
			const person = actor.kind === "user" ? actor : null;
			return c.json(
				{
					allowed: true,
					actor,
					userId: person?.userId ?? null,
					email: person?.email ?? null,
					sandboxId: encodeUuid("sandbox", t.sandboxId),
					machineId: t.machineId,
					sandboxState: t.state,
					loginUser: template?.loginUser ?? DEFAULT_LOGIN_USER,
					teamId: encodeUuid("team", t.teamId),
				},
				200,
			);
		},
	);
}

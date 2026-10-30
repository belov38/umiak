// SSH access of a sandbox (S7 §11.3): GET /ssh and short-lived login
// certificates signed by the SSH login CA.
import {
	encodeUuid,
	parseSshPublicKey,
	parseUserCertificate,
	type SshCa,
} from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testSettings } from "../src/testing/index.ts";
import type { HarnessResponse } from "./helpers/harness.ts";
import {
	bareKey,
	ecdsaP256PublicKey,
	ed25519PublicKey,
	rsaPublicKey,
	testSshCa,
} from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const EXTENSIONS = [
	"permit-X11-forwarding",
	"permit-agent-forwarding",
	"permit-port-forwarding",
	"permit-pty",
	"permit-user-rc",
];

describe.skipIf(skipPg())("SSH (S7 §11.3)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let ca: SshCa;
	let hostKeys: string[];
	let loginUser: string;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			topology: { node: { ramCapMb: 1_000_000 } },
			quota: {
				maxActiveSandboxes: 100,
				maxRamMb: 1_000_000,
				maxSavedSnapshots: 10,
			},
		});
		ca = testSshCa();
		hostKeys = [bareKey(ed25519PublicKey()), ecdsaP256PublicKey()];
		loginUser =
			(await w.env.config.template(w.env.template))?.loginUser ?? "missing";
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const harness = (
		over: Parameters<ApiWorld["deps"]>[0] = {},
		bearer?: string,
	) =>
		w.harness({
			deps: { sshCa: ca, hostKeys, ...over },
			...(bearer === undefined ? {} : { bearer }),
		});

	describe("GET /sandboxes/{sandbox}/ssh", () => {
		it("a team key: host, port, slug as username, loginUser of the template, known_hosts lines, hasKeys false", async () => {
			const s = await w.seed({ state: "ready" });
			const r = await harness().request("GET", `/v1/sandboxes/${s.slug}/ssh`);
			expect(r.status, r.text).toBe(200);
			expect(body(r)).toEqual({
				host: "ssh.sbx.test",
				port: 22,
				username: s.slug,
				loginUser,
				command: `ssh ${s.slug}@ssh.sbx.test`,
				knownHosts: hostKeys.map((k) => `ssh.sbx.test ${k}`),
				hasKeys: false,
			});
			// By sb_ id too.
			const byId = await harness().request(
				"GET",
				`/v1/sandboxes/${encodeUuid("sandbox", s.sandboxId)}/ssh`,
			);
			expect(body(byId).username).toBe(s.slug);
		});

		it("another port: `[host]:port` known_hosts lines and `ssh -p`", async () => {
			const s = await w.seed({ state: "stopped", machineState: "stopped" });
			const settings = testSettings({
				SBX_SSH_HOST: "ssh.example.com",
				SBX_SSH_PORT: "2222",
				SBX_API_RATE_BURST: "100000",
			});
			const r = await harness({ settings }).request(
				"GET",
				`/v1/sandboxes/${s.slug}/ssh`,
			);
			expect(r.status).toBe(200);
			expect(body(r)).toMatchObject({
				host: "ssh.example.com",
				port: 2222,
				command: `ssh -p 2222 ${s.slug}@ssh.example.com`,
				knownHosts: hostKeys.map((k) => `[ssh.example.com]:2222 ${k}`),
			});
		});

		it("a person: hasKeys says whether the person registered SSH keys", async () => {
			const s = await w.seed({ state: "ready" });
			const withKey = await w.dbSession({
				role: "member",
				deps: { sshCa: ca, hostKeys },
			});
			const k = parseSshPublicKey(ed25519PublicKey());
			await w.identity.addSshKey({
				userId: withKey.userId,
				name: "laptop",
				publicKey: `${k.type} ${k.blob.toString("base64")}`,
				fingerprint: k.fingerprint,
				type: k.type,
			});
			const yes = await withKey.h.request(
				"GET",
				`/v1/sandboxes/${s.slug}/ssh`,
				{
					headers: withKey.headers,
				},
			);
			expect(yes.status).toBe(200);
			expect(body(yes).hasKeys).toBe(true);

			const without = await w.dbSession({ role: "member" });
			const no = await without.h.request("GET", `/v1/sandboxes/${s.slug}/ssh`, {
				headers: without.headers,
			});
			expect(body(no)).toMatchObject({ hasKeys: false, knownHosts: [] });
		});

		it("another team's sandbox is 404; a key without ssh:connect is 403", async () => {
			const other = await w.seed({
				state: "ready",
				teamId: crypto.randomUUID(),
			});
			const r = await harness().request(
				"GET",
				`/v1/sandboxes/${other.slug}/ssh`,
			);
			expect(r.status).toBe(404);
			const s = await w.seed({ state: "ready" });
			const k = await w.key(["sandboxes:read"]);
			const f = await harness({}, k.secret).request(
				"GET",
				`/v1/sandboxes/${s.slug}/ssh`,
			);
			expect(f.status).toBe(403);
			expect(body(f).error.details.requiredScope).toBe("ssh:connect");
		});
	});

	describe("POST /sandboxes/{sandbox}/ssh/certificate", () => {
		const certify = (
			h: ReturnType<typeof harness>,
			slug: string,
			publicKey: string,
			headers: Record<string, string> = {},
		) =>
			h.request("POST", `/v1/sandboxes/${slug}/ssh/certificate`, {
				headers,
				json: { publicKey },
			});

		it("a team key: principal sb_..., KeyId sbx:key:key_..., 10 min, signed by the login CA", async () => {
			const s = await w.seed({ state: "ready" });
			const userKey = ed25519PublicKey();
			const before = Math.floor(Date.now() / 1000);
			const r = await certify(harness(), s.slug, userKey);
			const after = Math.ceil(Date.now() / 1000);
			expect(r.status, r.text).toBe(200);
			const b = body(r);
			const sb = encodeUuid("sandbox", s.sandboxId);
			expect(b).toMatchObject({
				principal: sb,
				host: "ssh.sbx.test",
				port: 22,
				username: s.slug,
				knownHosts: hostKeys.map((k) => `ssh.sbx.test ${k}`),
			});

			const cert = parseUserCertificate(b.certificate);
			expect(cert.type).toBe("ssh-ed25519-cert-v01@openssh.com");
			expect(cert.principals).toEqual([sb]);
			expect(cert.keyId).toBe(`sbx:key:${encodeUuid("apiKey", w.keyId)}`);
			expect(cert.publicKey).toBe(bareKey(userKey));
			expect(cert.signatureKey).toBe(ca.publicKey);
			expect(cert.extensions).toEqual(EXTENSIONS);
			expect(cert.criticalOptions).toEqual([]);
			const va = cert.validAfter.getTime() / 1000;
			const vb = cert.validBefore.getTime() / 1000;
			expect(vb - va).toBe(11 * 60);
			expect(va).toBeGreaterThanOrEqual(before - 61);
			expect(vb).toBeLessThanOrEqual(after + 600);
			expect(vb).toBeGreaterThanOrEqual(before + 599);
			// The response carries the certificate's own times.
			expect(Date.parse(b.validAfter)).toBe(cert.validAfter.getTime());
			expect(Date.parse(b.validBefore)).toBe(cert.validBefore.getTime());
		});

		it("a person: KeyId sbx:user:usr_...; ecdsa and RSA 3072 keys are accepted", async () => {
			const s = await w.seed({ state: "ready" });
			const p = await w.dbSession({
				role: "member",
				deps: { sshCa: ca, hostKeys },
			});
			const r = await certify(p.h, s.slug, ecdsaP256PublicKey(), p.headers);
			expect(r.status, r.text).toBe(200);
			const cert = parseUserCertificate(body(r).certificate);
			expect(cert.keyId).toBe(`sbx:user:${encodeUuid("user", p.userId)}`);
			expect(cert.type).toBe("ecdsa-sha2-nistp256-cert-v01@openssh.com");

			const rsa = await certify(harness(), s.slug, rsaPublicKey(3072));
			expect(rsa.status).toBe(200);
			expect(parseUserCertificate(body(rsa).certificate).type).toBe(
				"ssh-rsa-cert-v01@openssh.com",
			);
		});

		it("RSA 2048, a certificate, a private key or garbage is 400 validation", async () => {
			const s = await w.seed({ state: "ready" });
			const h = harness();
			const ok = await certify(h, s.slug, ed25519PublicKey());
			for (const publicKey of [
				rsaPublicKey(2048),
				body(ok).certificate,
				"-----BEGIN OPENSSH PRIVATE KEY-----",
				"ssh-ed25519 not-base64!",
				"",
			]) {
				const r = await certify(h, s.slug, publicKey);
				expect(r.status, publicKey.slice(0, 30)).toBe(400);
				expect(body(r).error.code).toBe("validation");
			}
			const rsa = await certify(h, s.slug, rsaPublicKey(2048));
			expect(body(rsa).error.message).toContain("3072");
		});

		it("the state of the sandbox is not checked: a stopped sandbox gets a certificate", async () => {
			const s = await w.seed({ state: "stopped", machineState: "stopped" });
			const r = await certify(harness(), s.slug, ed25519PublicKey());
			expect(r.status).toBe(200);
		});

		it("without SBX_SSH_LOGIN_CA_KEY_FILE: 500 internal, SSH login CA is not configured", async () => {
			const s = await w.seed({ state: "ready" });
			const r = await certify(
				harness({ sshCa: null }),
				s.slug,
				ed25519PublicKey(),
			);
			expect(r.status).toBe(500);
			expect(body(r).error).toMatchObject({
				code: "internal",
				message: "SSH login CA is not configured",
			});
		});

		it("another team's sandbox is 404; a key without ssh:connect is 403", async () => {
			const other = await w.seed({
				state: "ready",
				teamId: crypto.randomUUID(),
			});
			const r = await certify(harness(), other.slug, ed25519PublicKey());
			expect(r.status).toBe(404);
			const s = await w.seed({ state: "ready" });
			const k = await w.key(["sandboxes:read", "commands:exec"]);
			const f = await certify(
				harness({}, k.secret),
				s.slug,
				ed25519PublicKey(),
			);
			expect(f.status).toBe(403);
			expect(body(f).error.details.requiredScope).toBe("ssh:connect");
		});
	});
});

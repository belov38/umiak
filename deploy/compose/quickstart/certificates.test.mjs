import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayCertificates } from "./certificates.mjs";
import { testTls } from "./test-helpers/tls.mjs";

test("gateway status exposes CA and leaf expiry and warns before CA replacement needs template rebuilds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-guest-status-"));
	try {
		await testTls(dir);
		for (const name of ["tunnel.pem", "umiak.pem"])
			await copyFile(join(dir, "cert.pem"), join(dir, name));
		const status = await gatewayCertificates(dir);
		assert.ok(
			status.caExpiresAt && status.tunnelExpiresAt && status.previewExpiresAt,
		);
		assert.match(status.warning, /rebuilding agent packages and templates/);
		assert.equal(
			(await gatewayCertificates(dir, Date.now() - 366 * 86400000)).warning,
			null,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

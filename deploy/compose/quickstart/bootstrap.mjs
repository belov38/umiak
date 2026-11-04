// Import the installer's facts (install.json + host-report.json in the secrets
// dir) into quickstart setup state, so the browser wizard starts at Templates.

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { requireRootCA, validateConnection } from "./setup.mjs";
import {
	checkNode,
	pinnedPve,
	readOptional,
	verifyIsolation,
} from "./setup-host.mjs";

const LATER = ["templates", "smoke"];
const fail = (message) => {
	throw new Error(message);
};
// Postgres jsonb reorders object keys, so compare with keys sorted recursively.
const canonical = (value) =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, canonical(value[key])]),
				)
			: value;
const same = (a, b) =>
	JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

async function deniedAddresses(connection, lookup) {
	const found = [];
	for (const host of [
		new URL(connection.apiUrl).hostname,
		connection.sshHost,
	]) {
		if (isIP(host)) found.push(host);
		else
			try {
				for (const item of await lookup(host, { all: true }))
					found.push(item.address);
			} catch {}
	}
	return [...new Set(found)].sort();
}

function checkReport(report, gateway) {
	verifyIsolation(report.rules, report.ipset, gateway, report.denySets);
	if (
		!(
			Number(report.user?.enable ?? 1) === 1 &&
			report.zone?.type === "simple" &&
			report.vnet?.zone === "umiak" &&
			Number(report.firewall?.enable) === 1 &&
			report.vmFirewallsValid === true
		)
	)
		fail(
			"Installer host report does not match the required isolated Umiak setup",
		);
}

export async function bootstrapFromInstall({
	store,
	secretsDir = process.env.UMIAK_SECRETS_DIR || "/pve-secrets",
	steps,
	now = () => new Date(),
	makePve = pinnedPve,
	nodeCheck = checkNode,
	lookup = dnsLookup,
	installerNodeRetired = async () => false,
}) {
	const rawInstall = await readOptional(secretsDir, "install.json");
	if (!rawInstall) return "absent";
	const rawReport = await readOptional(secretsDir, "host-report.json");
	const digest = createHash("sha256")
		.update(rawInstall)
		.update("\0")
		.update(rawReport)
		.digest("hex");
	const attempt = async () => {
		const state = await store.read();
		if (state.bootstrap?.digest === digest) return "unchanged";
		const install = JSON.parse(rawInstall);
		if (install.version !== 1)
			fail(`Unsupported install.json version ${install.version}`);
		if (!rawReport) fail("host-report.json is missing next to install.json");
		const report = JSON.parse(rawReport);
		const { sshHost, ...network } = install.network ?? {};
		const connection = validateConnection(install.connection ?? {});
		checkReport(report, network.gatewayAddress);
		connection.deniedAddresses = await deniedAddresses(connection, lookup);
		requireRootCA(await readOptional(secretsDir, "pve-root-ca.pem"));
		if (
			(await readOptional(secretsDir, "pve-token-id")).trim() !==
			connection.tokenId
		)
			fail("pve-token-id does not match install.json connection.tokenId");
		const token = (await readOptional(secretsDir, "pve-token")).trim();
		const api = makePve(connection, token);
		await api.get("/version");
		await api.get("/pools/umiak");
		const retired = await installerNodeRetired(state);
		const node = retired
			? { version: "retired" }
			: await nodeCheck(connection, secretsDir);
		if (
			!retired &&
			(!node?.version ||
				node.config?.vmidMin !== 500 ||
				node.config?.vmidMax !== 589 ||
				node.config?.vnet !== "umiak0")
		)
			fail("Restricted node-agent configuration mismatch");
		// Work on a copy so any failure leaves persisted state untouched.
		const next = structuredClone(state);
		next.steps ??= {};
		const stamp = now().toISOString();
		const ready = (data) => ({ status: "ready", data, updatedAt: stamp });
		next.steps.connection = ready(connection);
		next.steps.host = ready({
			checks: [{ name: "installer host report", ok: true }],
			nodeVersion: node.version,
			ipset: report.ipset,
			rules: report.rules,
			denySets: report.denySets ?? {},
			reportAt: stamp,
		});
		// The limits step upserts the installer node's SQL rows before the state
		// write. That is safe: the upsert is idempotent, touches only the installer
		// node, and a failure leaves the digest unsaved so the next start retries.
		next.steps.limits = ready(
			await steps.limits(install.limits ?? {}, next, { bootstrap: true }),
		);
		next.steps.network = ready(await steps.network(network, next));
		// Compare installer facts only: step outputs include live PVE inventory
		// (occupied template VMIDs) that changes after every template build.
		const { deniedAddresses: _denied, ...connectionFacts } = connection;
		const facts = {
			connection: connectionFacts,
			limits: install.limits ?? {},
			network: { ...network, sshHost },
		};
		const changed = !same(state.bootstrap?.facts, facts);
		if (changed)
			for (const name of LATER)
				if (next.steps[name]) next.steps[name].status = "stale";
		next.complete = changed
			? false
			: ["connection", "host", "limits", "network", ...LATER].every(
					(name) => next.steps[name]?.status === "ready",
				);
		delete next.bootstrapError;
		next.bootstrap = {
			digest,
			importedAt: stamp,
			release: install.release,
			facts,
			sshHost,
			publicUrl: install.publicUrl,
		};
		await store.write(next);
		return "imported";
	};
	const run = async () => {
		try {
			return await attempt();
		} catch (error) {
			const state = await store.read();
			state.bootstrapError = {
				message: String(error.message),
				at: now().toISOString(),
				digest,
			};
			await store.write(state);
			throw error;
		}
	};
	return store.exclusive ? store.exclusive(run) : run();
}

// Startup wrapper: failures are logged and never prevent the server from listening.
export async function safeBootstrap(options, log = console.error) {
	try {
		return await bootstrapFromInstall(options);
	} catch (error) {
		log(`installer import failed: ${error.message}`);
		return "error";
	}
}

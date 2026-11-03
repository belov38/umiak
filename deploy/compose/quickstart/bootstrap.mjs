// Import the installer's facts (install.json + host-report.json in the secrets
// dir) into quickstart setup state, so the browser wizard starts at Templates.

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateConnection } from "./setup.mjs";
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
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
}) {
	const rawInstall = await readOptional(secretsDir, "install.json");
	if (!rawInstall) return "absent";
	const rawReport = await readOptional(secretsDir, "host-report.json");
	const digest = createHash("sha256")
		.update(rawInstall)
		.update("\0")
		.update(rawReport)
		.digest("hex");
	const run = async () => {
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
		const token = (await readOptional(secretsDir, "pve-token")).trim();
		await makePve(connection, token).get("/version");
		const node = await nodeCheck(connection, secretsDir);
		if (
			!node?.version ||
			(node.config &&
				(node.config.vmidMin !== 500 ||
					node.config.vmidMax !== 589 ||
					node.config.vnet !== "umiak0"))
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
		const previous = state.steps ?? {};
		next.steps.limits = ready(await steps.limits(install.limits ?? {}, next));
		next.steps.network = ready(await steps.network(network, next));
		const changed = ["connection", "limits", "network"].some(
			(name) => !same(previous[name]?.data, next.steps[name].data),
		);
		if (changed)
			for (const name of LATER)
				if (next.steps[name]) next.steps[name].status = "stale";
		next.complete = changed
			? false
			: ["connection", "host", "limits", "network", ...LATER].every(
					(name) => next.steps[name]?.status === "ready",
				);
		next.bootstrap = {
			digest,
			importedAt: stamp,
			release: install.release,
			sshHost,
			publicUrl: install.publicUrl,
		};
		await store.write(next);
		return "imported";
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

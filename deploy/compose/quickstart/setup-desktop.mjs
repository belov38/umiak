import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DESKTOP_MARKER,
	hasDesktopEvidence,
} from "../../../packages/config/src/desktop-marker.ts";

// Never infer capability from a Windows name, catalog slug, or missing DB row.
export async function windowsDesktop(config, node, vmid, registry) {
	if (
		String(config.tags || "")
			.split(/[;,]/)
			.includes(DESKTOP_MARKER)
	)
		return true;
	const id = /^umiak-tpl build ([a-f0-9-]{36})(?:\n|%0A|$)/i.exec(
		config.description || "",
	)?.[1];
	if (!id) return false;
	try {
		const m = JSON.parse(await readFile(join(registry, `${id}.json`), "utf8"));
		return (
			m.buildId === id &&
			m.node === node &&
			m.pveVmid === Number(vmid) &&
			m.vmName === config.name &&
			m.os === "windows" &&
			m.status === "ready" &&
			hasDesktopEvidence(m)
		);
	} catch (error) {
		if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
		throw error;
	}
}

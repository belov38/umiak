import type { ExecResult } from "@sbx/pve";
import type { GuestIo } from "./runner.ts";

// Guest side of the seal stage (spec S5 section 7.2 step 7): image facts for the manifest,
// files written through QGA stdin, seal, zero-fill, trim.

const MIN = 60_000;
/** Bytes per input-data call: Proxmox limits the size of a request parameter. */
const WRITE_CHUNK_BYTES = 32 * 1024;
const BUILD_LOG_DIR = "/var/log/sbx-build";
const SEED_DIR = "/mnt/seed";
// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format fields
const DPKG_FORMAT = "${db:Status-Abbrev}\t${Package}\t${Version}\n";

async function must(
	io: GuestIo,
	cmd: string[],
	o: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
	const r = await io.exec(cmd, o);
	if (r.exitCode !== 0)
		throw new Error(
			`guest: ${cmd[0] === "sh" || cmd[0] === "bash" ? cmd.slice(0, 3).join(" ") : cmd.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
		);
	return r;
}

/** Splits text into pieces of at most `maxBytes` UTF-8 bytes without cutting a character. */
export function chunkUtf8(text: string, maxBytes: number): string[] {
	const out: string[] = [];
	let cur = "";
	let size = 0;
	for (const ch of text) {
		const n = Buffer.byteLength(ch);
		if (size + n > maxBytes) {
			out.push(cur);
			cur = "";
			size = 0;
		}
		cur += ch;
		size += n;
	}
	if (cur !== "" || out.length === 0) out.push(cur);
	return out;
}

/**
 * Writes a guest file through exec stdin in chunks (the content never appears in a command
 * line), then moves it into place with mode 0644.
 */
export async function writeGuestFile(
	io: GuestIo,
	path: string,
	content: string,
): Promise<void> {
	const tmp = `${path}.tmp`;
	const chunks = chunkUtf8(content, WRITE_CHUNK_BYTES);
	for (const [i, chunk] of chunks.entries()) {
		const script =
			i === 0 ? 'mkdir -p "$(dirname "$1")" && cat > "$1"' : 'cat >> "$1"';
		await must(io, ["sh", "-c", script, "sh", tmp], { input: chunk });
	}
	await must(io, [
		"sh",
		"-c",
		'chmod 0644 "$1" && mv -f "$1" "$2"',
		"sh",
		tmp,
		path,
	]);
}

export interface ImageFacts {
	kernel: string;
	systemd: string;
	packages: Record<string, string>;
	tools: Record<string, string | null>;
}

/** Installed packages from `dpkg-query` lines `<status abbrev>\t<name>\t<version>`. */
export function parsePackages(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const [status = "", name, version] = line.split("\t");
		// Second letter of the abbreviation: i = installed (c = only config files left).
		if (name && version !== undefined && status.charAt(1) === "i")
			out[name] = version;
	}
	return out;
}

/** The `TOOLS <json>` line of verify.sh: tool -> direct value, null when missing. */
export function parseTools(stdout: string): Record<string, string | null> {
	const line = stdout.split("\n").find((l) => l.startsWith("TOOLS "));
	if (line === undefined) throw new Error("verify.sh printed no TOOLS line");
	const raw = JSON.parse(line.slice("TOOLS ".length)) as Record<
		string,
		{ direct: string; login: string }
	>;
	const out: Record<string, string | null> = {};
	for (const [k, v] of Object.entries(raw))
		out[k] = v.direct === "missing" ? null : v.direct;
	return out;
}

/** Reads kernel, systemd, packages and tool versions of the finished image. */
export async function collectFacts(
	io: GuestIo,
	verifyScript: string,
): Promise<ImageFacts> {
	const pkgs = await must(io, ["dpkg-query", "-W", "-f", DPKG_FORMAT], {
		timeoutMs: 2 * MIN,
	});
	const kernel = (await must(io, ["uname", "-r"])).stdout.trim();
	const systemd = (await must(io, ["systemctl", "--version"])).stdout
		.split("\n")[0]
		?.trim();
	// Each tool runs twice with a 30 s limit; the script reads its mode from the stdin prefix.
	const tools = await must(io, ["bash", "-s"], {
		input: `export SBX_VERIFY_MODE=tools\n${verifyScript}`,
		timeoutMs: 30 * MIN,
	});
	if (!kernel || !systemd)
		throw new Error("guest: empty uname -r or systemctl --version");
	return {
		kernel,
		systemd,
		packages: parsePackages(pkgs.stdout),
		tools: parseTools(tools.stdout),
	};
}

/**
 * Removes the build leftovers 90-cleanup cannot remove itself and the random seed, runs
 * `sbx-agent seal`, rebuilds the initrd, then zero-fills and trims the free space. Nothing may
 * write to the disk afterwards but shutdown.
 */
export async function sealGuest(io: GuestIo): Promise<void> {
	await must(io, [
		"bash",
		"-c",
		`umount ${SEED_DIR} 2>/dev/null || true; rmdir ${SEED_DIR} 2>/dev/null || true; rm -rf ${BUILD_LOG_DIR}`,
	]);
	// No two clones may share these. Stopping systemd-random-seed runs its ExecStop, which saves
	// a seed, so the files go after the stop; an inactive unit saves nothing at poweroff.
	await must(io, [
		"bash",
		"-c",
		"systemctl stop systemd-random-seed.service && ! systemctl is-active -q systemd-random-seed.service && rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret && sync",
	]);
	// After seal only the initrd and the zero file are written; fstrim then covers the freed blocks.
	await must(io, ["sbx-agent", "seal"], { timeoutMs: 2 * MIN });
	// dracut copies /etc/machine-id and /etc/hostname into the initrd: rebuilt now, it carries
	// the empty machine-id and the hostname sbx instead of the build VM's, so the early boot of
	// every clone runs and logs under the clone's own firmware machine-id.
	await must(io, ["update-initramfs", "-u", "-k", "all"], {
		timeoutMs: 10 * MIN,
	});
	// The persistent journal holds the build's last entries (tools run, seal) under the build
	// VM's machine-id; journald goes on in /run until poweroff, clones start an empty one.
	await must(io, [
		"bash",
		"-c",
		"journalctl --relinquish-var && rm -rf /var/log/journal/* && sync",
	]);
	// dd ends with "no space left", so its status does not count. Minutes on a 64 GiB disk.
	// The sync after rm commits the ext4 journal: fstrim skips blocks freed in a transaction
	// that is still open, and the template would keep the zero file's thin blocks (95% of 64 GiB
	// on a real build).
	await must(
		io,
		[
			"bash",
			"-c",
			"dd if=/dev/zero of=/var/tmp/sbx-zero bs=4M status=none || true; rm -f /var/tmp/sbx-zero; sync",
		],
		{ timeoutMs: 30 * MIN },
	);
	await must(io, ["fstrim", "-av"], { timeoutMs: 10 * MIN });
	await must(io, ["sync"], { timeoutMs: 5 * MIN });
}

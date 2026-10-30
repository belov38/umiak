import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IsoInstallSource } from "../recipe.ts";
import { fillTemplate } from "../seed.ts";

// Windows answer files (spec S9 sections 6.3, 6.4, 10.2, 10.3)

/** Shared Windows recipe directory in the repo; the defaults below read from it. */
export const WINDOWS_FILES_DIR = resolve(
	import.meta.dirname,
	"../../../../infra/templates/_windows",
);

function readWindowsFile(name: string): string {
	return readFileSync(join(WINDOWS_FILES_DIR, name), "utf8");
}

/** Escapes text for XML element content and attribute values. */
export function xmlEscape(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** Password `Value` with `PlainText=false`: base64 of UTF-16LE(password + "Password"). */
export function unattendPassword(password: string): string {
	return Buffer.from(`${password}Password`, "utf16le").toString("base64");
}

/** virtio-win drivers the install needs: disk, network, balloon, serial (QGA), rng. */
const VIRTIO_DRIVERS = [
	"vioscsi",
	"NetKVM",
	"viostor",
	"Balloon",
	"vioserial",
	"viorng",
];

/** Driver folders relative to the virtio-win ISO root, e.g. `vioscsi\w11\amd64`. */
export function virtioDriverPaths(
	drivers: IsoInstallSource["drivers"],
): string[] {
	return VIRTIO_DRIVERS.map((d) => `${d}\\${drivers}\\amd64`);
}

/** CD-ROM letters in the setup WinPE are not fixed; DriverPaths skips missing folders. */
const DRIVER_LETTERS = ["D", "E", "F", "G", "H", "I"];

export interface AutounattendInput {
	/** `/IMAGE/NAME` in install.wim. */
	edition: string;
	/** The product key itself (not its name in keys.toml); null for evaluation media. */
	productKey: string | null;
	/** Language of the ISO: windowsPE settings and the installed UI language. */
	uiLanguage: string;
	locale: IsoInstallSource["locale"];
	buildPassword: string;
	/** From `virtioDriverPaths`. */
	driverPaths: string[];
}

/** autounattend.xml of the build ISO; `template` defaults to `_windows/autounattend.xml.tmpl`. */
export function renderAutounattend(
	i: AutounattendInput,
	template = readWindowsFile("autounattend.xml.tmpl"),
): string {
	if (i.buildPassword === "") throw new Error("empty build password");
	if (i.edition === "") throw new Error("empty edition");
	if (i.driverPaths.length === 0) throw new Error("no virtio driver paths");

	const driverPaths = DRIVER_LETTERS.flatMap((letter) =>
		i.driverPaths.map((p) => `${letter}:\\${p}`),
	)
		.map(
			(p, n) =>
				`        <PathAndCredentials wcm:action="add" wcm:keyValue="${n + 1}">\n` +
				`          <Path>${xmlEscape(p)}</Path>\n` +
				"        </PathAndCredentials>",
		)
		.join("\n");
	const productKey =
		i.productKey === null
			? ""
			: "        <ProductKey>\n" +
				`          <Key>${xmlEscape(i.productKey)}</Key>\n` +
				"          <WillShowUI>OnError</WillShowUI>\n" +
				"        </ProductKey>";

	return fillTemplate(
		template,
		{
			ui_language: xmlEscape(i.uiLanguage),
			driver_paths: driverPaths,
			edition: xmlEscape(i.edition),
			product_key: productKey,
			keyboard: xmlEscape(i.locale.keyboard),
			formats: xmlEscape(i.locale.formats),
			timezone: xmlEscape(i.locale.timezone),
			password: unattendPassword(i.buildPassword),
		},
		"autounattend.xml.tmpl",
	);
}

/** Sysprep answers for clones (`_windows/sbx-unattend.xml`); no accounts, no passwords. */
export const SBX_UNATTEND = readWindowsFile("sbx-unattend.xml");

/** autounattend.xml of the offline ISO: only windowsPE, runs offline.cmd. */
export function renderOfflineAutounattend(
	template = readWindowsFile("offline-autounattend.xml"),
): string {
	return template;
}

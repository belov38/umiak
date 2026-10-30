import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
	type AutounattendInput,
	renderAutounattend,
	renderOfflineAutounattend,
	SBX_UNATTEND,
	unattendPassword,
	virtioDriverPaths,
} from "../src/windows/unattend.ts";

const PASSWORD = "Bu1ld-p@ss<&>\"'";

function input(extra: Partial<AutounattendInput> = {}): AutounattendInput {
	return {
		edition: "Windows 11 Pro",
		productKey: "VK7JG-NPHTM-C97JM-9MPGT-3V66T",
		uiLanguage: "en-GB",
		locale: { formats: "en-US", keyboard: "en-US", timezone: "UTC" },
		buildPassword: PASSWORD,
		driverPaths: virtioDriverPaths("w11"),
		...extra,
	};
}

// Arrays for every element that may repeat, so lookups do not depend on the count.
const REPEATED = new Set([
	"settings",
	"component",
	"RunSynchronousCommand",
	"PathAndCredentials",
	"CreatePartition",
	"ModifyPartition",
	"MetaData",
	"LocalAccount",
]);

interface Node {
	[k: string]: unknown;
}

function parse(xml: string): Node {
	expect(XMLValidator.validate(xml)).toBe(true);
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@",
		parseTagValue: false,
		isArray: (name) => REPEATED.has(name),
	});
	return parser.parse(xml) as Node;
}

function pass(doc: Node, name: string): Node {
	const all = (doc.unattend as Node).settings as Node[];
	const found = all.filter((s) => s["@pass"] === name);
	expect(found, name).toHaveLength(1);
	return found[0] as Node;
}

function component(settings: Node, name: string): Node {
	const c = (settings.component as Node[]).filter((x) => x["@name"] === name);
	expect(c, name).toHaveLength(1);
	return c[0] as Node;
}

function passes(doc: Node): string[] {
	return ((doc.unattend as Node).settings as Node[]).map(
		(s) => s["@pass"] as string,
	);
}

function commands(c: Node): string[] {
	const list = (c.RunSynchronous as Node).RunSynchronousCommand as Node[];
	return list
		.sort((a, b) => Number(a.Order) - Number(b.Order))
		.map((x) => x.Path as string);
}

function allComponents(doc: Node): Node[] {
	return ((doc.unattend as Node).settings as Node[]).flatMap(
		(s) => s.component as Node[],
	);
}

function expectComponentAttributes(doc: Node): void {
	for (const c of allComponents(doc)) {
		expect(c["@processorArchitecture"]).toBe("amd64");
		expect(c["@publicKeyToken"]).toBe("31bf3856ad364e35");
		expect(c["@language"]).toBe("neutral");
		expect(c["@versionScope"]).toBe("nonSxS");
	}
}

// A RunSynchronous Path is at most 259 characters.
function expectShortCommands(doc: Node): void {
	for (const s of (doc.unattend as Node).settings as Node[])
		for (const c of s.component as Node[])
			if (c.RunSynchronous !== undefined)
				for (const p of commands(c)) expect(p.length, p).toBeLessThan(260);
}

describe("unattendPassword", () => {
	it("is base64 of UTF-16LE(password + 'Password')", () => {
		expect(unattendPassword("")).toBe("UABhAHMAcwB3AG8AcgBkAA==");
		expect(
			Buffer.from(unattendPassword("ab"), "base64").toString("utf16le"),
		).toBe("abPassword");
	});
});

describe("renderAutounattend", () => {
	it("autounattend is well-formed XML with the edition and the build password only in LocalAccounts", () => {
		const xml = renderAutounattend(input());
		const doc = parse(xml);
		expect(passes(doc)).toEqual(["windowsPE", "specialize", "oobeSystem"]);
		expectComponentAttributes(doc);
		expectShortCommands(doc);

		const setup = component(
			pass(doc, "windowsPE"),
			"Microsoft-Windows-Setup",
		) as Node & {
			ImageInstall: Node;
			UserData: Node;
		};
		const meta = ((setup.ImageInstall.OSImage as Node).InstallFrom as Node)
			.MetaData as Node[];
		expect(meta).toEqual([
			expect.objectContaining({ Key: "/IMAGE/NAME", Value: "Windows 11 Pro" }),
		]);

		// The password never appears in clear text, and its encoded form only once.
		const encoded = unattendPassword(PASSWORD);
		expect(xml).not.toContain("Bu1ld-p@ss");
		expect(xml.split(encoded)).toHaveLength(2);
		const shell = component(
			pass(doc, "oobeSystem"),
			"Microsoft-Windows-Shell-Setup",
		);
		const accounts = ((shell.UserAccounts as Node).LocalAccounts as Node)
			.LocalAccount as Node[];
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			Name: "user",
			Group: "Administrators",
			Password: { Value: encoded, PlainText: "false" },
		});
		expect(xml.match(/<Password>/g)).toHaveLength(1);
		expect(xml).not.toContain("AdministratorPassword");
		expect(xml).not.toContain("AutoLogon");
	});

	it("XML-escapes the edition and the product key", () => {
		const xml = renderAutounattend(
			input({ edition: `Pro <&> "N" 'x'`, productKey: "A&B<C" }),
		);
		const doc = parse(xml);
		const setup = component(pass(doc, "windowsPE"), "Microsoft-Windows-Setup");
		const meta = ((setup.ImageInstall as Node).OSImage as Node)
			.InstallFrom as Node;
		const value = ((meta.MetaData as Node[])[0] as Node).Value as string;
		expect(value).toBe(`Pro <&> "N" 'x'`);
		expect(xml).not.toContain("A&B<C");
	});

	it("product key with WillShowUI OnError, none for evaluation media", () => {
		const withKey = parse(renderAutounattend(input()));
		const ud = component(pass(withKey, "windowsPE"), "Microsoft-Windows-Setup")
			.UserData as Node;
		expect(ud).toEqual({
			ProductKey: {
				Key: "VK7JG-NPHTM-C97JM-9MPGT-3V66T",
				WillShowUI: "OnError",
			},
			AcceptEula: "true",
		});

		const eval_ = parse(renderAutounattend(input({ productKey: null })));
		const ud2 = component(pass(eval_, "windowsPE"), "Microsoft-Windows-Setup")
			.UserData as Node;
		expect(ud2).toEqual({ AcceptEula: "true" });
	});

	it("windowsPE: UI language of the image, virtio drivers on D: to I:, GPT disk without recovery", () => {
		const doc = parse(renderAutounattend(input()));
		const pe = pass(doc, "windowsPE");
		const intl = component(pe, "Microsoft-Windows-International-Core-WinPE");
		expect(intl).toMatchObject({
			SetupUILanguage: { UILanguage: "en-GB" },
			InputLocale: "en-GB",
			SystemLocale: "en-GB",
			UILanguage: "en-GB",
			UserLocale: "en-GB",
		});

		const pnp = component(pe, "Microsoft-Windows-PnpCustomizationsWinPE");
		const entries = (pnp.DriverPaths as Node).PathAndCredentials as Node[];
		const paths = entries.map((e) => e.Path);
		for (const letter of ["D", "E", "F", "G", "H", "I"])
			for (const drv of [
				"vioscsi",
				"NetKVM",
				"viostor",
				"Balloon",
				"vioserial",
				"viorng",
			])
				expect(paths).toContain(`${letter}:\\${drv}\\w11\\amd64`);
		expect(entries).toHaveLength(36);
		const keys = entries.map((e) => e["@wcm:keyValue"]);
		expect(new Set(keys).size).toBe(36);

		const setup = component(pe, "Microsoft-Windows-Setup");
		const disk = (setup.DiskConfiguration as Node).Disk as Node;
		expect(disk.DiskID).toBe("0");
		expect(disk.WillWipeDisk).toBe("true");
		const parts = (disk.CreatePartitions as Node).CreatePartition as Node[];
		expect(
			parts.map((p) => [p.Order, p.Type, p.Size ?? null, p.Extend ?? null]),
		).toEqual([
			["1", "EFI", "260", null],
			["2", "MSR", "16", null],
			["3", "Primary", null, "true"],
		]);
		const mods = (disk.ModifyPartitions as Node).ModifyPartition as Node[];
		expect(mods.find((m) => m.PartitionID === "1")?.Format).toBe("FAT32");
		expect(mods.find((m) => m.PartitionID === "3")).toMatchObject({
			Format: "NTFS",
			Letter: "C",
		});
		expect(((setup.ImageInstall as Node).OSImage as Node).InstallTo).toEqual({
			DiskID: "0",
			PartitionID: "3",
		});
	});

	it("2k25 driver paths", () => {
		expect(virtioDriverPaths("2k25")).toContain("vioscsi\\2k25\\amd64");
	});

	it("specialize: device encryption off, SetupComplete.cmd copied from the build ISO", () => {
		const doc = parse(renderAutounattend(input()));
		const sp = pass(doc, "specialize");
		const cmds = commands(component(sp, "Microsoft-Windows-Deployment"));
		expect(cmds).toContain(
			"reg.exe add HKLM\\SYSTEM\\CurrentControlSet\\Control\\BitLocker /v PreventDeviceEncryption /t REG_DWORD /d 1 /f",
		);
		const copy = cmds.find((c) => c.includes("SetupComplete.cmd copy"));
		expect(copy).toBeDefined();
		expect(copy).toContain("%d:\\build\\SetupComplete.cmd");
		expect(copy).toContain("C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd");
		for (const l of ["D", "E", "F", "G", "H", "I", "J", "K"])
			expect(copy).toMatch(new RegExp(`\\(.*\\b${l}\\b.*\\)`));
		// The scripts directory exists before the copy.
		const mk = cmds.findIndex((c) => c.includes("mkdir"));
		expect(mk).toBeGreaterThanOrEqual(0);
		expect(mk).toBeLessThan(cmds.indexOf(copy as string));
	});

	it("oobeSystem: screens hidden, en-US formats and keyboard, UTC", () => {
		const doc = parse(renderAutounattend(input()));
		const oobe = pass(doc, "oobeSystem");
		const shell = component(oobe, "Microsoft-Windows-Shell-Setup");
		expect(shell.OOBE).toMatchObject({
			HideEULAPage: "true",
			HideOEMRegistrationScreen: "true",
			HideOnlineAccountScreens: "true",
			HideWirelessSetupInOOBE: "true",
			ProtectYourPC: "3",
		});
		expect(shell.TimeZone).toBe("UTC");
		const intl = component(oobe, "Microsoft-Windows-International-Core");
		expect(intl).toMatchObject({
			InputLocale: "en-US",
			SystemLocale: "en-US",
			UserLocale: "en-US",
			UILanguage: "en-GB",
		});
	});

	it("rejects an empty password", () => {
		expect(() => renderAutounattend(input({ buildPassword: "" }))).toThrow(
			/password/,
		);
	});
});

describe("SBX_UNATTEND", () => {
	it("sbx-unattend contains no Password element", () => {
		const doc = parse(SBX_UNATTEND);
		expect(SBX_UNATTEND).not.toMatch(/Password/i);
		expect(SBX_UNATTEND).not.toContain("UserAccounts");
		expect(SBX_UNATTEND).not.toContain("AutoLogon");
		expectComponentAttributes(doc);
		expectShortCommands(doc);
		expect(passes(doc)).toEqual(["generalize", "specialize", "oobeSystem"]);
	});

	it("generalize keeps devices, specialize runs identity apply", () => {
		const doc = parse(SBX_UNATTEND);
		const pnp = component(
			pass(doc, "generalize"),
			"Microsoft-Windows-PnpSysprep",
		);
		expect(pnp.PersistAllDeviceInstalls).toBe("true");
		const cmds = commands(
			component(pass(doc, "specialize"), "Microsoft-Windows-Deployment"),
		);
		expect(cmds).toEqual([
			'"C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe" identity apply --specialize',
		]);
	});

	it("oobeSystem hides every screen, en-US, UTC", () => {
		const doc = parse(SBX_UNATTEND);
		const oobe = pass(doc, "oobeSystem");
		const shell = component(oobe, "Microsoft-Windows-Shell-Setup");
		expect(shell.OOBE).toMatchObject({
			HideEULAPage: "true",
			HideOEMRegistrationScreen: "true",
			HideOnlineAccountScreens: "true",
			HideWirelessSetupInOOBE: "true",
			ProtectYourPC: "3",
		});
		expect(shell.TimeZone).toBe("UTC");
		expect(
			component(oobe, "Microsoft-Windows-International-Core"),
		).toMatchObject({
			InputLocale: "en-US",
			SystemLocale: "en-US",
			UserLocale: "en-US",
		});
	});
});

describe("renderOfflineAutounattend", () => {
	it("only windowsPE, runs offline.cmd from the offline ISO", () => {
		const xml = renderOfflineAutounattend();
		const doc = parse(xml);
		expect(passes(doc)).toEqual(["windowsPE"]);
		expectComponentAttributes(doc);
		expectShortCommands(doc);
		const cmds = commands(
			component(pass(doc, "windowsPE"), "Microsoft-Windows-Setup"),
		);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]).toMatch(/^cmd\.exe \/c /);
		expect(cmds[0]).toContain("%d:\\offline.cmd");
		// Nothing that could install Windows.
		expect(xml).not.toContain("ImageInstall");
		expect(xml).not.toContain("DiskConfiguration");
		expect(xml).not.toMatch(/Password/i);
	});
});

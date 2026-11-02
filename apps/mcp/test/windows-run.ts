// Live Windows input probe for infra/dev-cp acceptance: types a pwsh line into the Run
// dialog of the console session and proves it ran. exec runs in session 0, so the dialog
// is opened by a one-shot interactive task of user.
import type { Sandbox } from "@umiak/sdk";

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const SCRIPT = "C:\\Users\\Public\\umiak-e2e-run.ps1";
const RECT = "C:\\Users\\Public\\umiak-e2e-run.json";
/**
 * Runs in the session of user: opens Run and records the screen rectangle of its
 * command box. Window lookup needs no foreground rights; focus comes from real clicks.
 */
const OPEN_AND_LOCATE = String.raw`Add-Type @'
using System; using System.Runtime.InteropServices;
public static class UmiakRun {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
Start-Process explorer.exe 'shell:::{2559a1f3-21d7-11d4-bdaf-00c04f60b9f0}'
for ($i = 0; $i -lt 100; $i++) {
 $h = [UmiakRun]::FindWindow('#32770', 'Run')
 if ($h -ne 0 -and [UmiakRun]::IsWindowVisible($h)) {
  $box = [UmiakRun]::FindWindowEx($h, 0, 'ComboBox', $null)
  $r = New-Object UmiakRun+Rect
  if ($box -ne 0 -and [UmiakRun]::GetWindowRect($box, [ref]$r)) {
   @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } | ConvertTo-Json -Compress | Set-Content -Encoding ascii '${RECT}'
   exit 0
  }
 }
 Start-Sleep -Milliseconds 100
}
exit 1`;
/** Registers and starts the task, then waits for the rectangle (empty output: no dialog). */
const START_TASK = `Remove-Item -ErrorAction Ignore '${RECT}';$a=New-ScheduledTaskAction -Execute conhost.exe -Argument '--headless "${PWSH}" -NoLogo -NoProfile -NonInteractive -File ${SCRIPT}';$p=New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\user" -LogonType Interactive;Register-ScheduledTask -TaskName s10-run -TaskPath '\\umiak\\' -Action $a -Principal $p -Force|Out-Null;Start-ScheduledTask -TaskName s10-run -TaskPath '\\umiak\\';for($i=0;$i -lt 60 -and -not (Test-Path '${RECT}');$i++){Start-Sleep -Milliseconds 250};Unregister-ScheduledTask -TaskName s10-run -TaskPath '\\umiak\\' -Confirm:$false;if(Test-Path '${RECT}'){[Console]::Write((Get-Content -Raw '${RECT}'))}`;

const pwsh = (script: string) => [
	PWSH,
	"-NoLogo",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	script,
];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Types `line` (via `type`, which must also press Enter) into a focused Run dialog
 * until the file `proof` under the profile of user holds `expected`. On a fresh logon
 * Start or a notification can take focus between opening and typing; each attempt
 * clicks into the command box first and is checked by the proof, not by a screenshot.
 */
export async function typeIntoRunDialog(
	sandbox: Sandbox,
	proof: string,
	expected: string,
	type: () => Promise<void>,
	attempts = 3,
): Promise<number> {
	await sandbox.files.writeText(SCRIPT, OPEN_AND_LOCATE);
	const proofPath = `(Join-Path $env:USERPROFILE '${proof}')`;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		await sandbox.exec(pwsh(`Remove-Item -ErrorAction Ignore ${proofPath}`));
		const opened = await sandbox.exec(pwsh(START_TASK));
		const rect = opened.stdout.trim()
			? (JSON.parse(opened.stdout) as {
					left: number;
					top: number;
					right: number;
					bottom: number;
				})
			: undefined;
		if (rect) {
			const x = rect.left + 40;
			const y = Math.round((rect.top + rect.bottom) / 2);
			// The first click may only dismiss Start; the second focuses the box.
			await sandbox.desktop.act({
				actions: [
					{ type: "wait", ms: 500 },
					{ type: "click", x, y },
					{ type: "wait", ms: 700 },
					{ type: "click", x, y },
					{ type: "wait", ms: 300 },
					{ type: "key", keys: ["ctrl", "a"] },
				],
			});
			await type();
			for (let i = 0; i < 20; i++) {
				await sleep(500);
				const read = await sandbox.exec(
					pwsh(
						`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);if(Test-Path ${proofPath}){[Console]::Write((Get-Content -Raw -Encoding utf8 ${proofPath}))}`,
					),
				);
				if (read.exitCode === 0 && read.stdout === expected) return attempt;
			}
		}
		console.log(
			`Run dialog attempt ${attempt}: ${rect ? "typed text did not run" : "dialog did not open"}`,
		);
		// Close whatever kept the focus (Start, a leftover dialog) before the next try.
		await sandbox.desktop.act({
			actions: [
				{ type: "key", keys: ["escape"] },
				{ type: "wait", ms: 300 },
				{ type: "key", keys: ["escape"] },
				{ type: "wait", ms: 500 },
			],
		});
	}
	throw new Error("typed text never reached the Windows shell");
}

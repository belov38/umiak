#requires -Version 7
# 65-streamer (spec S10 section 7): Sunshine, moonlight-web and cua-driver on top of the
# S9 image. The streamer services stay Manual; the agent starts them on Desktop/Open.
# agent.toml with [desktop] and the streamer port exclusions is rendered by sbx-tpl.
. (Join-Path $PSScriptRoot '..\lib.ps1')
. (Join-Path $SbxFilesDir 'desktop-install.ps1')
Install-SbxDesktop -ProgramRoot $env:ProgramFiles -AgentRoot (Join-Path $env:ProgramData 'sbx-agent') -WorkRoot (Join-Path $SbxWorkDir 'desktop') -FilesRoot $SbxFilesDir

# Display 1920x1080 (spec S10 section 7): OVMF sets the GOP mode of vga: std from its
# PlatformConfig variable (OvmfPkg PlatformDxe), and the Microsoft Basic Display Adapter keeps
# that mode. The variable lives in efidisk0, which clones copy from the template.
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SbxFirmware {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SetFirmwareEnvironmentVariableExW(string name, string guid, byte[] value, int size, int attributes);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct Privileges { public int Count; public long Luid; public int Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privileges state, int length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    public static bool EnableSystemEnvironment() {
        IntPtr token; long luid;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token) || !LookupPrivilegeValueW(null, "SeSystemEnvironmentPrivilege", out luid)) return false;
        var p = new Privileges { Count = 1, Luid = luid, Attributes = 2 };
        return AdjustTokenPrivileges(token, false, ref p, 0, IntPtr.Zero, IntPtr.Zero) && Marshal.GetLastWin32Error() == 0;
    }
}
'@
if (-not [SbxFirmware]::EnableSystemEnvironment()) { throw 'SeSystemEnvironmentPrivilege unavailable' }
$mode = [byte[]]::new(8)
[BitConverter]::GetBytes([uint32]1920).CopyTo($mode, 0)
[BitConverter]::GetBytes([uint32]1080).CopyTo($mode, 4)
# NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS
if (-not [SbxFirmware]::SetFirmwareEnvironmentVariableExW('PlatformConfig', '{7235c51c-0c80-4cab-87ac-3b084a6304b1}', $mode, 8, 7)) {
    throw "PlatformConfig: error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
Write-BuildLog 'OVMF PlatformConfig 1920x1080'

# Edge is the browser of the Windows desktop: no first-run, sign-in, sync or default-browser prompts.
$edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
Set-RegValue $edge HideFirstRunExperience 1
Set-RegValue $edge BrowserSignin 0
Set-RegValue $edge SyncDisabled 1
Set-RegValue $edge DefaultBrowserSettingEnabled 0
Set-RegValue $edge PromotionalTabsEnabled 0
Set-RegValue $edge ShowRecommendationsEnabled 0

Write-BuildLog 'done'

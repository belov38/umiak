#requires -Version 7
# 60-desktop (spec S9 section 8.7, Decision 2): no lock screen, no first-logon
# screens. The profile of user is created from the Default User hive at the
# first autologon on a clone; the autologon keys are written by identity
# apply there, not here. No session task (desktop helper is S10).
. (Join-Path $PSScriptRoot '..\lib.ps1')

$policies = 'HKLM:\SOFTWARE\Policies\Microsoft'

# --- Machine ---
# Honoured by Enterprise, Education and Server; verify checks the result on Pro.
Set-RegValue "$policies\Windows\Personalization" NoLockScreen 1
# No password when the console wakes up.
foreach ($ac in @('/setacvalueindex', '/setdcvalueindex')) {
    Invoke-Native -FilePath powercfg.exe -ArgumentList @($ac, 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0')
}
Invoke-Native -FilePath powercfg.exe -ArgumentList @('/setactive', 'SCHEME_CURRENT')
# First logon: no animation, no privacy experience, no Hello/PIN offer.
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' EnableFirstLogonAnimation 0
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' EnableFirstLogonAnimation 0
Set-RegValue "$policies\Windows\OOBE" DisablePrivacyExperience 1
Set-RegValue "$policies\PassportForWork" Enabled 0
Set-RegValue "$policies\PassportForWork" DisablePostLogonProvisioning 1
Set-RegValue "$policies\Windows\System" AllowDomainPINLogon 0
Set-RegValue "$policies\Windows\CloudContent" DisableWindowsSpotlightFeatures 1
Set-RegValue "$policies\Windows\CloudContent" DisableSpotlightCollectionOnDesktop 1

# --- Default User hive: what the profile of user starts with ---
Invoke-WithDefaultUserHive {
    param($root)
    $sw = "$root\Software"
    $cv = "$sw\Microsoft\Windows\CurrentVersion"
    Set-RegValue "$cv\Policies\System" DisableLockWorkstation 1
    # Screen saver off.
    Set-RegValue "$root\Control Panel\Desktop" ScreenSaveActive '0' String
    Set-RegValue "$root\Control Panel\Desktop" ScreenSaverIsSecure '0' String
    Set-RegValue "$sw\Policies\Microsoft\Windows\Control Panel\Desktop" ScreenSaveActive '0' String
    # "Let's finish setting up your device" (SCOOBE).
    Set-RegValue "$cv\UserProfileEngagement" ScoobeSystemSettingEnabled 0
    # Tips, suggestions, Spotlight, silently installed apps.
    $cdm = "$cv\ContentDeliveryManager"
    foreach ($n in @(
            'ContentDeliveryAllowed', 'FeatureManagementEnabled', 'OemPreInstalledAppsEnabled',
            'PreInstalledAppsEnabled', 'PreInstalledAppsEverEnabled', 'SilentInstalledAppsEnabled',
            'SoftLandingEnabled', 'SystemPaneSuggestionsEnabled', 'RotatingLockScreenEnabled',
            'RotatingLockScreenOverlayEnabled', 'SubscribedContentEnabled',
            'SubscribedContent-310093Enabled', 'SubscribedContent-338387Enabled', 'SubscribedContent-338388Enabled',
            'SubscribedContent-338389Enabled', 'SubscribedContent-338393Enabled', 'SubscribedContent-353694Enabled',
            'SubscribedContent-353696Enabled', 'SubscribedContent-353698Enabled')) {
        Set-RegValue $cdm $n 0
    }
    Set-RegValue "$cv\Notifications\Settings\Windows.SystemToast.Suggested" Enabled 0
    Set-RegValue "$sw\Policies\Microsoft\Windows\CloudContent" DisableWindowsSpotlightFeatures 1
    Set-RegValue "$sw\Policies\Microsoft\Windows\CloudContent" DisableTailoredExperiencesWithDiagnosticData 1
    # Start and taskbar: no recommendations, Widgets, Copilot.
    $adv = "$cv\Explorer\Advanced"
    Set-RegValue $adv Start_IrisRecommendations 0
    Set-RegValue $adv Start_AccountNotifications 0
    Set-RegValue $adv TaskbarDa 0
    Set-RegValue $adv ShowCopilotButton 0
    # Privacy: no advertising id, no tailored experiences.
    Set-RegValue "$cv\AdvertisingInfo" Enabled 0
    Set-RegValue "$cv\Privacy" TailoredExperiencesWithDiagnosticDataEnabled 0
    # OneDrive is never set up for the user.
    Remove-RegValue "$cv\Run" 'OneDriveSetup'
}

Write-BuildLog 'done'

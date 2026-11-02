# AllUsersAllHosts profile of pwsh 7 and Windows PowerShell 5.1 (spec S9
# section 8.4), installed by 50-umiak-agent as $PSHOME\profile.ps1.
# SSH sessions get the sandbox env from the agent. Commands of the agent come
# with UMIAK_ENV_APPLIED=1 and keep their own env.
# The agent output is parsed, not executed: only two assignment forms to $env:K
# are applied (K matches ^[A-Za-z_][A-Za-z0-9_]*$), everything else is ignored:
#   $env:K = '<value, single quotes doubled>'
#   $env:K = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('<base64>'))
# Keep this file ASCII and 5.1-compatible.

try {
    $umiakUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $umiakUtf8
    [Console]::OutputEncoding = $umiakUtf8
    $OutputEncoding = $umiakUtf8
} catch { }

if (-not $env:UMIAK_ENV_APPLIED) {
    $umiakAgent = 'C:\Program Files\umiak-agent\current\umiak-agent.exe'
    if (Test-Path -LiteralPath $umiakAgent) {
        try {
            $umiakOut = (& $umiakAgent env --format pwsh 2>$null) -join "`n"
            if ($LASTEXITCODE -eq 0 -and $umiakOut) {
                $umiakErrors = $null
                $umiakAst = [System.Management.Automation.Language.Parser]::ParseInput($umiakOut, [ref]$null, [ref]$umiakErrors)
                if ($umiakErrors.Count -eq 0) {
                    foreach ($umiakSt in $umiakAst.EndBlock.Statements) {
                        if ($umiakSt -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or $umiakSt.Operator -ne 'Equals') { continue }
                        if ($umiakSt.Right -isnot [System.Management.Automation.Language.CommandExpressionAst]) { continue }
                        $umiakLeft = $umiakSt.Left
                        $umiakRight = $umiakSt.Right.Expression
                        if ($umiakLeft -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $umiakLeft.VariablePath.DriveName -ne 'env') { continue }
                        $umiakName = $umiakLeft.VariablePath.UserPath.Substring(4)
                        if ($umiakName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
                        $umiakValue = $null
                        if ($umiakRight -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $umiakRight.StringConstantType -eq 'SingleQuoted') {
                            $umiakValue = $umiakRight.Value
                        } elseif ($umiakRight -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                            $umiakRight.Extent.Text -match '^\[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\(''([A-Za-z0-9+/=]*)''\)\)$') {
                            try { $umiakValue = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[1])) } catch { $umiakValue = $null }
                        }
                        if ($null -ne $umiakValue) { [Environment]::SetEnvironmentVariable($umiakName, $umiakValue, 'Process') }
                    }
                    $env:UMIAK_ENV_APPLIED = '1'
                }
            }
        } catch { }
    }
    Remove-Variable -Name umiakAgent, umiakOut, umiakErrors, umiakAst, umiakSt, umiakLeft, umiakRight, umiakName, umiakValue -ErrorAction SilentlyContinue
}
Remove-Variable -Name umiakUtf8 -ErrorAction SilentlyContinue

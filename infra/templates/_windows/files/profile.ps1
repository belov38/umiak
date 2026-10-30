# AllUsersAllHosts profile of pwsh 7 and Windows PowerShell 5.1 (spec S9
# section 8.4), installed by 50-sbx-agent as $PSHOME\profile.ps1.
# SSH sessions get the sandbox env from the agent. Commands of the agent come
# with SBX_ENV_APPLIED=1 and keep their own env.
# The agent output is parsed, not executed: only two assignment forms to $env:K
# are applied (K matches ^[A-Za-z_][A-Za-z0-9_]*$), everything else is ignored:
#   $env:K = '<value, single quotes doubled>'
#   $env:K = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('<base64>'))
# Keep this file ASCII and 5.1-compatible.

try {
    $sbxUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $sbxUtf8
    [Console]::OutputEncoding = $sbxUtf8
    $OutputEncoding = $sbxUtf8
} catch { }

if (-not $env:SBX_ENV_APPLIED) {
    $sbxAgent = 'C:\Program Files\sbx-agent\current\sbx-agent.exe'
    if (Test-Path -LiteralPath $sbxAgent) {
        try {
            $sbxOut = (& $sbxAgent env --format pwsh 2>$null) -join "`n"
            if ($LASTEXITCODE -eq 0 -and $sbxOut) {
                $sbxErrors = $null
                $sbxAst = [System.Management.Automation.Language.Parser]::ParseInput($sbxOut, [ref]$null, [ref]$sbxErrors)
                if ($sbxErrors.Count -eq 0) {
                    foreach ($sbxSt in $sbxAst.EndBlock.Statements) {
                        if ($sbxSt -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or $sbxSt.Operator -ne 'Equals') { continue }
                        if ($sbxSt.Right -isnot [System.Management.Automation.Language.CommandExpressionAst]) { continue }
                        $sbxLeft = $sbxSt.Left
                        $sbxRight = $sbxSt.Right.Expression
                        if ($sbxLeft -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $sbxLeft.VariablePath.DriveName -ne 'env') { continue }
                        $sbxName = $sbxLeft.VariablePath.UserPath.Substring(4)
                        if ($sbxName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
                        $sbxValue = $null
                        if ($sbxRight -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $sbxRight.StringConstantType -eq 'SingleQuoted') {
                            $sbxValue = $sbxRight.Value
                        } elseif ($sbxRight -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                            $sbxRight.Extent.Text -match '^\[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\(''([A-Za-z0-9+/=]*)''\)\)$') {
                            try { $sbxValue = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Matches[1])) } catch { $sbxValue = $null }
                        }
                        if ($null -ne $sbxValue) { [Environment]::SetEnvironmentVariable($sbxName, $sbxValue, 'Process') }
                    }
                    $env:SBX_ENV_APPLIED = '1'
                }
            }
        } catch { }
    }
    Remove-Variable -Name sbxAgent, sbxOut, sbxErrors, sbxAst, sbxSt, sbxLeft, sbxRight, sbxName, sbxValue -ErrorAction SilentlyContinue
}
Remove-Variable -Name sbxUtf8 -ErrorAction SilentlyContinue

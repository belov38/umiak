# AllUsersAllHosts profile of pwsh 7 and Windows PowerShell 5.1 (spec S9
# section 8.4), installed by 50-sbx-agent as $PSHOME\profile.ps1.
# SSH sessions get the sandbox env from the agent. Commands of the agent come
# with SBX_ENV_APPLIED=1 and keep their own env.
# The agent output ($env:NAME = 'value' lines) is parsed, not executed: only
# assignments of single-quoted constants to $env: variables are applied.
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
                        if ($sbxLeft -is [System.Management.Automation.Language.VariableExpressionAst] -and
                            $sbxLeft.VariablePath.DriveName -eq 'env' -and
                            $sbxRight -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                            $sbxRight.StringConstantType -eq 'SingleQuoted') {
                            [Environment]::SetEnvironmentVariable($sbxLeft.VariablePath.UserPath.Substring(4), $sbxRight.Value, 'Process')
                        }
                    }
                    $env:SBX_ENV_APPLIED = '1'
                }
            }
        } catch { }
    }
    Remove-Variable -Name sbxAgent, sbxOut, sbxErrors, sbxAst, sbxSt, sbxLeft, sbxRight -ErrorAction SilentlyContinue
}
Remove-Variable -Name sbxUtf8 -ErrorAction SilentlyContinue

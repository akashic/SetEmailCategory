#Requires -Version 7.2
<#
.SYNOPSIS
    Fills the custom connector templates in /connector with environment-specific values and writes them to
    connector/dist/<env>/ ready for `pac connector create` or import in the Power Apps maker portal.

.EXAMPLE
    ./Build-ConnectorDefinition.ps1 -EntraOutput ./entra-output.prod.json `
        -FunctionHostName func-setemailcat-prod-abc123.azurewebsites.net -Publisher 'Contoso IT'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EntraOutput,
    [Parameter(Mandatory)] [string] $FunctionHostName,
    [Parameter(Mandatory)] [string] $Publisher
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$entra = Get-Content $EntraOutput -Raw | ConvertFrom-Json
$root = Join-Path $PSScriptRoot '..' 'connector'
$outDir = Join-Path $root 'dist' $entra.environment
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tokens = @{
    '{{FUNCTION_HOST}}'       = $FunctionHostName
    '{{CONNECTOR_CLIENT_ID}}' = $entra.connectorClientId
    '{{API_IDENTIFIER_URI}}'  = $entra.apiIdentifierUri
    '{{TENANT_ID}}'           = $entra.tenantId
    '{{PUBLISHER}}'           = $Publisher
}

foreach ($file in 'apiDefinition.swagger.json', 'apiProperties.json') {
    $content = Get-Content (Join-Path $root $file) -Raw
    foreach ($token in $tokens.GetEnumerator()) { $content = $content.Replace($token.Key, $token.Value) }
    if ($content -match '\{\{[A-Z_]+\}\}') { throw "Unreplaced token $($Matches[0]) in $file" }
    $null = $content | ConvertFrom-Json # validate JSON
    Set-Content -Path (Join-Path $outDir $file) -Value $content -Encoding utf8NoBOM
}

Write-Host "Connector files written to $outDir" -ForegroundColor Green
Write-Host 'Next: pac connector create --api-definition-file ... --api-properties-file ... (see docs/RUNBOOK.md, Phase 5)'

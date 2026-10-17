#Requires -Version 7.2
<#
.SYNOPSIS
    Creates (or updates) the two Entra ID app registrations used by SetEmailCategory. Safe to re-run.

.DESCRIPTION
    1. "<Workload> API (<env>)" - represents the Function App. Easy Auth validates tokens issued for it.
       Exposes the delegated scope 'user_impersonation' and issues v2.0 access tokens.
    2. "<Workload> Connector (<env>)" - the OAuth client used by the Power Platform custom connector.
       Granted admin consent to the API scope. A client secret is created on first run (or with -RotateSecret).

    Neither app gets any Microsoft Graph permission. Mailbox access belongs to the Function App's managed
    identity and is granted in Exchange Online by Grant-MailboxAccess.ps1.

    Requires: Azure CLI signed in (az login) as a user with Application Administrator (or Cloud Application
    Administrator) in Entra ID.

.EXAMPLE
    ./Setup-EntraApps.ps1 -Environment prod -CallerGroupObjectId 1b2c... -OutputPath ./entra-output.prod.json

.EXAMPLE
    # After creating the custom connector, add its unique redirect URI:
    ./Setup-EntraApps.ps1 -Environment prod -ConnectorRedirectUri 'https://global.consent.azure-apim.net/redirect/cr123-5fsetemailcat-5f0123456789abcdef'
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('dev', 'test', 'prod')]
    [Parameter(Mandatory)]
    [string] $Environment,

    [string] $Workload = 'SetEmailCategory',

    # Security group whose members may use the connector. The API then requires assignment, so users outside the
    # group cannot obtain a token for it at all. Required unless -AllowAnyTenantUser is passed: the function acts
    # with its own mailbox permission, so without a group anyone the connector is shared with can change categories
    # on any message in the shared mailbox, whether or not they have access to that mailbox themselves.
    [string] $CallerGroupObjectId,

    # Explicitly accept that any user in the tenant may obtain a token for the API (e.g. a dev environment).
    [switch] $AllowAnyTenantUser,

    # Per-connector redirect URI shown on the custom connector's Security tab after it is created.
    [string] $ConnectorRedirectUri,

    [ValidateRange(1, 24)]
    [int] $SecretValidityMonths = 12,

    [switch] $RotateSecret,

    [string] $OutputPath = "./entra-output.$Environment.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $CallerGroupObjectId -and -not $AllowAnyTenantUser) {
    throw ('Pass -CallerGroupObjectId with the security group allowed to use the connector (normally the people who ' +
        'already have access to the shared mailbox). To let any user in the tenant call the API, pass -AllowAnyTenantUser.')
}

$GraphUri = 'https://graph.microsoft.com/v1.0'
# Stable ID so re-runs never create a second scope.
$ScopeId = [guid]::new([System.Security.Cryptography.MD5]::HashData([Text.Encoding]::UTF8.GetBytes("$Workload/$Environment/user_impersonation"))).ToString()
$DefaultAccessRoleId = '00000000-0000-0000-0000-000000000000'
$GlobalRedirectUri = 'https://global.consent.azure-apim.net/redirect'

function Invoke-Graph {
    param([string] $Method, [string] $Path, [object] $Body)
    $azArgs = @('rest', '--method', $Method, '--uri', "$GraphUri/$Path", '--headers', 'Content-Type=application/json')
    if ($null -ne $Body) {
        $file = New-TemporaryFile
        try {
            $Body | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path $file -Encoding utf8NoBOM
            $azArgs += @('--body', "@$file")
            $result = az @azArgs
        }
        finally { Remove-Item $file -Force }
    }
    else {
        $result = az @azArgs
    }
    if ($result) { $result | ConvertFrom-Json -Depth 20 }
}

function Get-OrCreateApp {
    [CmdletBinding(SupportsShouldProcess)]
    param([string] $DisplayName)
    $existing = Invoke-Graph GET "applications?`$filter=displayName eq '$DisplayName'&`$select=id,appId,displayName,web,api,requiredResourceAccess"
    if ($existing.value.Count -gt 1) { throw "More than one app registration is named '$DisplayName'. Resolve manually." }
    if ($existing.value.Count -eq 1) {
        Write-Host "Found app registration '$DisplayName' ($($existing.value[0].appId))"
        return $existing.value[0]
    }
    if (-not $PSCmdlet.ShouldProcess($DisplayName, 'Create app registration')) { throw 'Aborted.' }
    Write-Host "Creating app registration '$DisplayName'"
    return Invoke-Graph POST 'applications' @{ displayName = $DisplayName; signInAudience = 'AzureADMyOrg' }
}

function Get-OrCreateServicePrincipal {
    param([string] $AppId)
    $existing = Invoke-Graph GET "servicePrincipals?`$filter=appId eq '$AppId'&`$select=id,appId,appRoleAssignmentRequired"
    if ($existing.value.Count -eq 1) { return $existing.value[0] }
    Write-Host "Creating service principal for $AppId"
    return Invoke-Graph POST 'servicePrincipals' @{ appId = $AppId }
}

az account show --only-show-errors | Out-Null
$tenantId = az account show --query tenantId -o tsv

# ---------------------------------------------------------------- API app
$api = Get-OrCreateApp "$Workload API ($Environment)"
$apiIdentifierUri = "api://$($api.appId)"

if (-not ($api.api.oauth2PermissionScopes | Where-Object id -eq $ScopeId)) {
    Write-Host 'Configuring API scope, identifier URI and v2 tokens'
    Invoke-Graph PATCH "applications/$($api.id)" @{
        identifierUris = @($apiIdentifierUri)
        api            = @{
            requestedAccessTokenVersion = 2
            oauth2PermissionScopes      = @(@{
                    id                      = $ScopeId
                    value                   = 'user_impersonation'
                    type                    = 'User'
                    isEnabled               = $true
                    adminConsentDisplayName = "Access $Workload"
                    adminConsentDescription = "Allows the app to set Outlook categories on messages in the $Workload shared mailbox on behalf of the signed-in user."
                    userConsentDisplayName  = "Access $Workload"
                    userConsentDescription  = "Allows the app to set Outlook categories on messages in the $Workload shared mailbox on your behalf."
                })
        }
    } | Out-Null
}

$apiSp = Get-OrCreateServicePrincipal $api.appId

if ($CallerGroupObjectId) {
    if (-not $apiSp.appRoleAssignmentRequired) {
        Write-Host 'Requiring assignment on the API enterprise application'
        Invoke-Graph PATCH "servicePrincipals/$($apiSp.id)" @{ appRoleAssignmentRequired = $true } | Out-Null
    }
    $assigned = Invoke-Graph GET "servicePrincipals/$($apiSp.id)/appRoleAssignedTo"
    if (-not ($assigned.value | Where-Object principalId -eq $CallerGroupObjectId)) {
        Write-Host "Assigning group $CallerGroupObjectId to the API"
        Invoke-Graph POST "servicePrincipals/$($apiSp.id)/appRoleAssignedTo" @{
            principalId = $CallerGroupObjectId
            resourceId  = $apiSp.id
            appRoleId   = $DefaultAccessRoleId
        } | Out-Null
    }
}

# ---------------------------------------------------------------- Connector client app
$connector = Get-OrCreateApp "$Workload Connector ($Environment)"

$redirectUris = [Collections.Generic.List[string]]::new()
$redirectUris.Add($GlobalRedirectUri)
if ($connector.web -and $connector.web.redirectUris) { $connector.web.redirectUris | ForEach-Object { if (-not $redirectUris.Contains($_)) { $redirectUris.Add($_) } } }
if ($ConnectorRedirectUri -and -not $redirectUris.Contains($ConnectorRedirectUri)) { $redirectUris.Add($ConnectorRedirectUri) }

Write-Host 'Configuring connector redirect URIs and API permission'
Invoke-Graph PATCH "applications/$($connector.id)" @{
    web                    = @{ redirectUris = $redirectUris.ToArray() }
    requiredResourceAccess = @(@{
            resourceAppId  = $api.appId
            resourceAccess = @(@{ id = $ScopeId; type = 'Scope' })
        })
} | Out-Null

$connectorSp = Get-OrCreateServicePrincipal $connector.appId

# Tenant-wide admin consent for the connector to call the API scope (so users aren't prompted).
$grants = Invoke-Graph GET "oauth2PermissionGrants?`$filter=clientId eq '$($connectorSp.id)' and resourceId eq '$($apiSp.id)'"
if (-not $grants.value) {
    Write-Host 'Granting admin consent for user_impersonation'
    Invoke-Graph POST 'oauth2PermissionGrants' @{
        clientId    = $connectorSp.id
        consentType = 'AllPrincipals'
        resourceId  = $apiSp.id
        scope       = 'user_impersonation'
    } | Out-Null
}

# ---------------------------------------------------------------- Client secret
$secretInfo = $null
$existingSecrets = (Invoke-Graph GET "applications/$($connector.id)?`$select=passwordCredentials").passwordCredentials
if (-not $existingSecrets -or $RotateSecret) {
    $endDate = (Get-Date).ToUniversalTime().AddMonths($SecretValidityMonths).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $secretInfo = az ad app credential reset --id $connector.appId --append --display-name "power-platform-connector-$(Get-Date -Format yyyyMMdd)" --end-date $endDate --only-show-errors | ConvertFrom-Json
}

# ---------------------------------------------------------------- Output (no secrets written to disk)
$output = [ordered]@{
    tenantId                = $tenantId
    environment             = $Environment
    apiAppClientId          = $api.appId
    apiIdentifierUri        = $apiIdentifierUri
    connectorClientId       = $connector.appId
    connectorRedirectUris   = $redirectUris
}
$output | ConvertTo-Json | Set-Content -Path $OutputPath -Encoding utf8NoBOM

Write-Host ''
Write-Host "Wrote $OutputPath" -ForegroundColor Green
$output | Format-List | Out-String | Write-Host

if ($secretInfo) {
    Write-Host 'CONNECTOR CLIENT SECRET (shown once - store it in your password vault now; it is needed when creating the custom connector):' -ForegroundColor Yellow
    Write-Host "  $($secretInfo.password)" -ForegroundColor Yellow
    Write-Host "  Expires: $endDate"
}
else {
    Write-Host 'A connector client secret already exists; not creating another. Use -RotateSecret to add a new one.'
}

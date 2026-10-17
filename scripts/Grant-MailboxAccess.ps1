#Requires -Version 7.2
<#
.SYNOPSIS
    Grants the Function App's managed identity Mail.ReadWrite on ONE shared mailbox using
    Exchange Online RBAC for Applications. Safe to re-run.

.DESCRIPTION
    RBAC for Applications grants are additive with Entra ID application permissions. If the managed identity
    also had Microsoft Graph or Office 365 Exchange Online application permissions consented in Entra ID, it
    could access EVERY mailbox and this scope would be meaningless - so the script refuses to continue if it
    finds any.

    Requires:
      - Azure CLI signed in (to resolve the managed identity's appId).
      - Exchange Online: member of Organization Management (or Exchange Administrator in Entra ID).
      - ExchangeOnlineManagement PowerShell module (installed for the current user if missing).

    Permission changes take 30 minutes to 2 hours to take effect for the app (Exchange caches them).
    Test-ServicePrincipalAuthorization at the end bypasses that cache.

.EXAMPLE
    ./Grant-MailboxAccess.ps1 -ResourceGroup rg-setemailcat-prod -FunctionAppName func-setemailcat-prod-abc123 `
        -SharedMailbox invoices@contoso.com -NegativeTestMailbox someone.else@contoso.com
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $ResourceGroup,
    [Parameter(Mandatory)] [string] $FunctionAppName,
    [Parameter(Mandatory)] [string] $SharedMailbox,

    # Optional: a mailbox that must NOT be in scope. Used to prove the restriction works.
    [string] $NegativeTestMailbox,

    [string] $Organization
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$RoleName = 'Application Mail.ReadWrite'

# Some Exchange Online cmdlets throw a terminating error for "not found" regardless of -ErrorAction.
function Get-OrNull([scriptblock] $Query) {
    try { & $Query } catch { $null }
}

# Application permissions on these APIs reach every mailbox in the tenant (e.g. Graph Mail.ReadWrite, or Exchange
# Online full_access_as_app for EWS), so any of them would bypass the single-mailbox scope granted below.
$TenantWideMailApis = [ordered]@{
    '00000003-0000-0000-c000-000000000000' = 'Microsoft Graph'
    '00000002-0000-0ff1-ce00-000000000000' = 'Office 365 Exchange Online'
}

# ---------------------------------------------------------------- Resolve the managed identity
$principalId = az functionapp identity show -g $ResourceGroup -n $FunctionAppName --query principalId -o tsv
if (-not $principalId) { throw "Function app '$FunctionAppName' has no system-assigned managed identity." }
$appId = az ad sp show --id $principalId --query appId -o tsv
Write-Host "Managed identity: objectId=$principalId appId=$appId"

# ---------------------------------------------------------------- Guard: no tenant-wide mail API grants
$assignments = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" | ConvertFrom-Json
$found = foreach ($api in $TenantWideMailApis.GetEnumerator()) {
    $resourceSp = az ad sp show --id $api.Key --query id -o tsv
    $count = @($assignments.value | Where-Object resourceId -eq $resourceSp).Count
    if ($count -gt 0) { "$count $($api.Value)" }
}
if ($found) {
    throw ("The managed identity has application permission(s) granted in Entra ID: $($found -join ', '). " +
        'These apply to ALL mailboxes and override the Exchange scope. Remove them first ' +
        "(Entra admin centre > Enterprise applications > $FunctionAppName > Permissions).")
}

# ---------------------------------------------------------------- Exchange Online
if (-not (Get-Module -ListAvailable ExchangeOnlineManagement)) {
    Write-Host 'Installing ExchangeOnlineManagement module for the current user'
    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force
}
Import-Module ExchangeOnlineManagement
$connectParams = @{ ShowBanner = $false }
if ($Organization) { $connectParams.Organization = $Organization }
Connect-ExchangeOnline @connectParams

try {
    $mailbox = Get-EXOMailbox -Identity $SharedMailbox -Properties RecipientTypeDetails
    if ($mailbox.RecipientTypeDetails -ne 'SharedMailbox') {
        Write-Warning "$SharedMailbox is a $($mailbox.RecipientTypeDetails), not a SharedMailbox. Continuing."
    }
    $address = $mailbox.PrimarySmtpAddress.ToString()

    # Pointer from Exchange to the Entra service principal.
    $sp = Get-OrNull { Get-ServicePrincipal -Identity $appId -ErrorAction Stop }
    if (-not $sp -and $PSCmdlet.ShouldProcess($FunctionAppName, 'New-ServicePrincipal')) {
        $sp = New-ServicePrincipal -AppId $appId -ObjectId $principalId -DisplayName $FunctionAppName
    }

    # Management scope containing exactly this mailbox.
    $scopeName = "SetEmailCategory - $address"
    $filter = "PrimarySmtpAddress -eq '$address'"
    $scope = Get-OrNull { Get-ManagementScope -Identity $scopeName -ErrorAction Stop }
    if (-not $scope -and $PSCmdlet.ShouldProcess($scopeName, 'New-ManagementScope')) {
        $scope = New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $filter
    }
    elseif ($scope -and $scope.RecipientFilter -notmatch [regex]::Escape($address)) {
        throw "Management scope '$scopeName' exists but its filter doesn't reference $address : $($scope.RecipientFilter)"
    }

    $assignmentName = "SetEmailCategory - $FunctionAppName - Mail.ReadWrite"
    $existing = Get-OrNull { Get-ManagementRoleAssignment -Identity $assignmentName -ErrorAction Stop }
    if (-not $existing -and $PSCmdlet.ShouldProcess($assignmentName, 'New-ManagementRoleAssignment')) {
        New-ManagementRoleAssignment -Name $assignmentName -Role $RoleName -App $appId -CustomResourceScope $scopeName | Out-Null
    }

    # ------------------------------------------------------------ Verify (bypasses the permission cache)
    Write-Host "`nAuthorization for $address :"
    $inScope = Test-ServicePrincipalAuthorization -Identity $appId -Resource $address | Where-Object RoleName -eq $RoleName
    $inScope | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope | Out-String | Write-Host
    if (-not ($inScope | Where-Object InScope -eq $true)) { throw "$RoleName is not in scope for $address." }

    if ($NegativeTestMailbox) {
        Write-Host "Authorization for $NegativeTestMailbox (must be out of scope):"
        $outOfScope = Test-ServicePrincipalAuthorization -Identity $appId -Resource $NegativeTestMailbox | Where-Object RoleName -eq $RoleName
        $outOfScope | Format-Table RoleName, InScope | Out-String | Write-Host
        if ($outOfScope | Where-Object InScope -eq $true) { throw "$NegativeTestMailbox is unexpectedly in scope." }
    }

    Write-Host 'Done. Allow 30 minutes to 2 hours before the function can use the new permission.' -ForegroundColor Green
}
finally {
    Disconnect-ExchangeOnline -Confirm:$false | Out-Null
}

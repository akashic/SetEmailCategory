#Requires -Version 7.2
<#
.SYNOPSIS
    Creates the deployment identity used by GitHub Actions (OIDC - no stored secrets) and grants it
    least-privilege access to the target resource group. Safe to re-run.

.DESCRIPTION
    - Creates the resource group if it does not exist.
    - Creates a user-assigned managed identity with a federated credential trusted only for
      <subject prefix>:environment:<env> (so only jobs running in that GitHub environment can deploy).
      The prefix is read from the repo's OIDC settings, so it matches whether GitHub issues the name-based
      subject (repo:<owner>/<repo>) or the immutable one (repo:<owner>@<owner-id>/<repo>@<repo-id>).
      An existing name-based credential is migrated, and removed once the immutable one exists.
    - Grants it, on the resource group only:
        * Contributor
        * Role Based Access Control Administrator, constrained by an ABAC condition so it can ONLY assign the
          three roles the Function App needs, and only to service principals.
    - Reads the environment's parameter file and checks its network settings with Test-NetworkPrerequisites.ps1
      before changing anything. For each existing network resource it names outside the resource group, grants,
      scoped to that resource only:
        * subnet or NSG: the custom role 'SetEmailCategory Network Join' (read and join, nothing else; created or
          extended here), or Network Contributor with -UseBuiltInNetworkRole
        * the VNet of each existing subnet: Reader (VNet integration and the checks read the VNet)
        * private DNS zone: Private DNS Zone Contributor (the private endpoints' A records are written there)
      Network grants from earlier runs that the parameter file no longer needs are removed.
    - Optionally writes the GitHub environment variables with the gh CLI.

    Requires: Azure CLI (with Bicep) signed in as Owner (or User Access Administrator + Contributor) on the
    subscription/RG; for existing network resources outside it, Owner or User Access Administrator on them and
    permission to create custom roles on their resource groups; and the gh CLI signed in with read access to the
    repo (or pass -OidcSubjectPrefix). -WhatIf shows the changes without making them.

.EXAMPLE
    ./Setup-GitHubOidc.ps1 -SubscriptionId 0000... -ResourceGroup rg-setemailcat-prod -Location uksouth `
        -GitHubRepository WilliamBuckAustralia/SetEmailCategory -GitHubEnvironment prod -SetGitHubVariables

.EXAMPLE
    # Preview what would change, including grants on existing network resources named in the parameter file.
    ./Setup-GitHubOidc.ps1 -SubscriptionId 0000... -ResourceGroup rg-setemailcat-prod -Location australiaeast `
        -GitHubRepository WilliamBuckAustralia/SetEmailCategory -GitHubEnvironment prod -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string] $SubscriptionId,
    [Parameter(Mandatory)] [string] $ResourceGroup,
    [Parameter(Mandatory)] [string] $Location,
    [Parameter(Mandatory)] [ValidatePattern('^[^/]+/[^/]+$')] [string] $GitHubRepository,
    [ValidateSet('dev', 'test', 'prod')] [string] $GitHubEnvironment = 'prod',
    [string] $IdentityName = "id-github-setemailcat-$GitHubEnvironment",

    # Subject prefix GitHub puts in the OIDC token, e.g. repo:contoso@123/SetEmailCategory@456. Read from
    # GET repos/<repo>/actions/oidc/customization/sub when omitted; pass it only if gh isn't available.
    [ValidatePattern('^repo:')] [string] $OidcSubjectPrefix,

    # Parameter file the deployment uses; its network settings decide the grants. Default: infra/env/<env>.bicepparam.
    [string] $ParameterFile,
    # Grant Network Contributor instead of the custom join-only role, where nobody can create custom roles.
    [switch] $UseBuiltInNetworkRole,

    [switch] $SetGitHubVariables
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# Roles the Bicep template assigns to the Function App's managed identity (infra/modules/functionApp.bicep).
$AssignableRoles = @(
    'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' # Storage Blob Data Owner
    '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' # Storage Table Data Contributor
    '3913510d-42f4-4e42-8a64-420c390055eb' # Monitoring Metrics Publisher
) -join ', '

# Custom role for existing subnets and NSGs: enough to attach the app and private endpoints, and nothing else
# (Network Contributor would also let the pipeline change or delete the platform's network).
$JoinRoleName = 'SetEmailCategory Network Join'
$JoinRoleActions = @(
    'Microsoft.Network/virtualNetworks/subnets/read'
    'Microsoft.Network/virtualNetworks/subnets/join/action'
    'Microsoft.Network/networkSecurityGroups/read'
    'Microsoft.Network/networkSecurityGroups/join/action'
)

az account set --subscription $SubscriptionId

# Fail before creating anything if the network settings can't work.
if (-not $ParameterFile) { $ParameterFile = Join-Path $PSScriptRoot "../infra/env/$GitHubEnvironment.bicepparam" }
$network = & "$PSScriptRoot/Test-NetworkPrerequisites.ps1" -ParameterFile $ParameterFile -ResourceGroup $ResourceGroup `
    -Location $Location -PassThru
if (($network.Location -replace '\s', '') -ne ($Location -replace '\s', '')) {
    throw "$ParameterFile deploys to $($network.Location) but -Location is $Location. Use the same region."
}
$tenantId = az account show --query tenantId -o tsv

if ((az group exists -n $ResourceGroup) -ne 'true') {
    if (-not $PSCmdlet.ShouldProcess($ResourceGroup, 'Create resource group')) {
        Write-Host 'The remaining steps need the resource group, so the preview stops here.'
        return
    }
    az group create -n $ResourceGroup -l $Location --only-show-errors | Out-Null
}
$rgId = az group show -n $ResourceGroup --query id -o tsv

$identity = az identity list -g $ResourceGroup --query "[?name=='$IdentityName'] | [0]" --only-show-errors | ConvertFrom-Json
if (-not $identity) {
    if (-not $PSCmdlet.ShouldProcess($IdentityName, 'Create managed identity')) {
        Write-Host 'The remaining steps need the identity, so the preview stops here.'
        return
    }
    Write-Host "Creating managed identity $IdentityName"
    $identity = az identity create -g $ResourceGroup -n $IdentityName -l $Location --only-show-errors | ConvertFrom-Json
}

# The subject GitHub issues depends on the repo's OIDC settings: name-based (repo:owner/repo) or immutable
# (repo:owner@id/repo@id), the default for repos created or renamed since July 2026. Entra matches it exactly.
function Get-OidcSubjectPrefix {
    try { $sub = gh api "repos/$GitHubRepository/actions/oidc/customization/sub" | ConvertFrom-Json }
    catch { throw "Couldn't read the OIDC subject settings of $GitHubRepository with gh ($_). Sign in with 'gh auth login', or pass -OidcSubjectPrefix." }
    if (-not $sub.use_default) {
        throw "$GitHubRepository uses a custom OIDC subject template. Create the federated credential by hand, matching the sub claim it produces."
    }
    if ($sub.PSObject.Properties['sub_claim_prefix'] -and $sub.sub_claim_prefix) { return $sub.sub_claim_prefix }
    if (-not ($sub.PSObject.Properties['use_immutable_subject'] -and $sub.use_immutable_subject)) { return "repo:$GitHubRepository" }
    $repo = gh api "repos/$GitHubRepository" | ConvertFrom-Json
    return "repo:$($repo.owner.login)@$($repo.owner.id)/$($repo.name)@$($repo.id)"
}

if (-not $OidcSubjectPrefix) { $OidcSubjectPrefix = Get-OidcSubjectPrefix }
$subject = "$($OidcSubjectPrefix):environment:$GitHubEnvironment"
$legacySubject = "repo:$($GitHubRepository):environment:$GitHubEnvironment"
$fedName = "github-$GitHubEnvironment"
$fedArgs = @('-g', $ResourceGroup, '--identity-name', $IdentityName, '--only-show-errors')
$issuerArgs = @('--issuer', 'https://token.actions.githubusercontent.com', '--subject', $subject, '--audiences', 'api://AzureADTokenExchange')

$creds = @(az identity federated-credential list @fedArgs | ConvertFrom-Json)
if (-not ($creds | Where-Object subject -ceq $subject)) {
    $named = $creds | Where-Object name -eq $fedName
    if (-not $named) {
        if ($PSCmdlet.ShouldProcess($subject, 'Add federated credential')) {
            az identity federated-credential create @fedArgs --name $fedName @issuerArgs | Out-Null
        }
    }
    elseif ($named.subject -eq $legacySubject) {
        if ($PSCmdlet.ShouldProcess($fedName, "Update federated credential from $($named.subject) to $subject")) {
            az identity federated-credential update @fedArgs --name $fedName @issuerArgs | Out-Null
        }
    }
    else {
        throw "Federated credential '$fedName' exists with subject '$($named.subject)'."
    }
}

# A name-based credential left beside the immutable one would trust any future repo given this name.
if ($subject -cne $legacySubject) {
    $creds = @(az identity federated-credential list @fedArgs | ConvertFrom-Json)
    foreach ($stale in $creds | Where-Object { $_.subject -eq $legacySubject -and $_.subject -cne $subject }) {
        if ($PSCmdlet.ShouldProcess($stale.name, "Remove name-based federated credential ($legacySubject)")) {
            az identity federated-credential delete @fedArgs --name $stale.name --yes | Out-Null
        }
    }
}

function Grant-Role {
    param([string] $Role, [string] $Condition, [string] $Scope = $rgId)
    $scopeName = ($Scope -split '/')[-1]
    $existing = az role assignment list --assignee $identity.principalId --scope $Scope --role $Role --query '[].id' -o tsv
    if ($existing) { Write-Host "Already has '$Role' on $scopeName"; return }
    if (-not $PSCmdlet.ShouldProcess($scopeName, "Grant '$Role'")) { return }
    Write-Host "Granting '$Role' on $scopeName"
    $roleArgs = @('role', 'assignment', 'create', '--assignee-object-id', $identity.principalId,
        '--assignee-principal-type', 'ServicePrincipal', '--role', $Role, '--scope', $Scope, '--only-show-errors')
    if ($Condition) { $roleArgs += @('--condition', $Condition, '--condition-version', '2.0') }
    # A custom role created moments ago can take a few minutes to replicate before it can be assigned.
    for ($attempt = 1; ; $attempt++) {
        try { az @roleArgs | Out-Null; return }
        catch {
            if ($attempt -ge 6) { throw }
            Write-Host "  Not assignable yet, retrying in 20 s ($_)"
            Start-Sleep -Seconds 20
        }
    }
}

# Creates the join-only custom role, or adds resource groups to its assignable scopes. Returns whether the role
# exists afterwards (not when -WhatIf skipped creating it).
function Set-JoinRole([string[]] $ResourceGroupIds) {
    # A definition is only listed at scopes it's assignable to, so look where it's needed (role names are unique
    # per tenant; if it exists only elsewhere, creating it fails and says so).
    $role = $ResourceGroupIds | Sort-Object -Unique | ForEach-Object {
        az role definition list --name $JoinRoleName --custom-role-only true --scope $_ --only-show-errors | ConvertFrom-Json
    } | Select-Object -First 1
    $current = if ($role) { @($role.assignableScopes) } else { @() }
    $missing = @($ResourceGroupIds | Sort-Object -Unique | Where-Object { $_ -notin $current })
    if ($role -and -not $missing) { return $true }
    $action = if ($role) { "Add assignable scopes $($missing -join ', ')" } else { 'Create custom role' }
    if (-not $PSCmdlet.ShouldProcess($JoinRoleName, $action)) { return [bool]$role }
    $definition = if ($role) {
        $role.assignableScopes = @($current + $missing)
        $role
    }
    else {
        [ordered]@{
            Name             = $JoinRoleName
            IsCustom         = $true
            Description      = 'Read and join subnets and network security groups, nothing else. Lets the SetEmailCategory deployment use network resources it does not own.'
            Actions          = $JoinRoleActions
            NotActions       = @()
            AssignableScopes = $missing
        }
    }
    $file = New-TemporaryFile
    try {
        $definition | ConvertTo-Json -Depth 10 | Set-Content $file
        $verb = if ($role) { 'update' } else { 'create' }
        az role definition $verb --role-definition $file.FullName --only-show-errors | Out-Null
    }
    finally { Remove-Item $file }
    $true
}

Grant-Role 'Contributor'

# Constrained delegation: may only create/delete assignments of the listed roles, to service principals.
$condition = @"
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$AssignableRoles} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase 'ServicePrincipal')) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$AssignableRoles}))
"@
Grant-Role 'Role Based Access Control Administrator' $condition

# Existing network resources outside the RG, which Contributor on the RG doesn't cover. Each grant is scoped to the
# one resource that needs it.
$joinRole = if ($UseBuiltInNetworkRole) { 'Network Contributor' } else { $JoinRoleName }
$isOutsideRg = { param([string] $Id) $Id -and -not $Id.StartsWith("$rgId/", [StringComparison]::OrdinalIgnoreCase) }
$grants = @(
    if ($network.PrivateNetworking) {
        foreach ($subnetId in $network.AppSubnetId, $network.PrivateEndpointSubnetId) {
            if (& $isOutsideRg $subnetId) {
                [pscustomobject]@{ Role = $joinRole; Scope = $subnetId }
                $vnetId = $subnetId.Substring(0, $subnetId.IndexOf('/subnets/', [StringComparison]::OrdinalIgnoreCase))
                [pscustomobject]@{ Role = 'Reader'; Scope = $vnetId }
            }
        }
        if (& $isOutsideRg $network.NsgId) { [pscustomobject]@{ Role = $joinRole; Scope = $network.NsgId } }
        foreach ($zoneId in $network.BlobPrivateDnsZoneId, $network.TablePrivateDnsZoneId) {
            if (& $isOutsideRg $zoneId) { [pscustomobject]@{ Role = 'Private DNS Zone Contributor'; Scope = $zoneId } }
        }
    }
) | Sort-Object Role, Scope -Unique

$joinRoleExists = $true
$joinRoleScopes = @($grants | Where-Object { $_.Role -eq $JoinRoleName } | ForEach-Object { ($_.Scope -split '/')[0..4] -join '/' })
if ($joinRoleScopes) { $joinRoleExists = Set-JoinRole $joinRoleScopes }
foreach ($grant in $grants) {
    if ($grant.Role -eq $JoinRoleName -and -not $joinRoleExists) {
        Write-Host "What if: Grant '$JoinRoleName' on $(($grant.Scope -split '/')[-1]) once the role exists"
        continue
    }
    Grant-Role $grant.Role -Scope $grant.Scope
}

# Remove network grants from earlier runs that the parameter file no longer needs (a changed or removed ID, or a
# switch between the custom and built-in role). Only this script's roles on network resources outside the RG are
# touched, so nothing granted to the identity for another reason is removed.
$managedRoles = @($JoinRoleName, 'Network Contributor', 'Reader', 'Private DNS Zone Contributor')
$wanted = @($grants | ForEach-Object { "$($_.Role)|$($_.Scope)".ToLowerInvariant() })
$subscriptions = @(@($SubscriptionId) + @($grants | ForEach-Object { ($_.Scope -split '/')[2] }) | Sort-Object -Unique)
foreach ($sub in $subscriptions) {
    $assignments = az role assignment list --assignee $identity.principalId --all --subscription $sub `
        --query '[].{id:id, scope:scope, role:roleDefinitionName}' -o json --only-show-errors | ConvertFrom-Json
    foreach ($assignment in @($assignments)) {
        if (-not $assignment -or $assignment.role -notin $managedRoles) { continue }
        if ($assignment.scope -notmatch '/providers/Microsoft\.Network/' -or -not (& $isOutsideRg $assignment.scope)) { continue }
        if ("$($assignment.role)|$($assignment.scope)".ToLowerInvariant() -in $wanted) { continue }
        if ($PSCmdlet.ShouldProcess($assignment.scope, "Remove '$($assignment.role)' no longer needed")) {
            az role assignment delete --ids $assignment.id --only-show-errors
        }
    }
}

$vars = [ordered]@{
    AZURE_CLIENT_ID       = $identity.clientId
    AZURE_TENANT_ID       = $tenantId
    AZURE_SUBSCRIPTION_ID = $SubscriptionId
    AZURE_RESOURCE_GROUP  = $ResourceGroup
}

if ($SetGitHubVariables) {
    gh api --method PUT "repos/$GitHubRepository/environments/$GitHubEnvironment" --silent
    foreach ($kv in $vars.GetEnumerator()) {
        gh variable set $kv.Key --env $GitHubEnvironment --repo $GitHubRepository --body $kv.Value
    }
    Write-Host "Set variables on GitHub environment '$GitHubEnvironment'." -ForegroundColor Green
}
else {
    Write-Host "`nCreate GitHub environment '$GitHubEnvironment' and add these environment variables (not secrets - they are identifiers):" -ForegroundColor Green
    $vars | Format-Table -HideTableHeaders | Out-String | Write-Host
}

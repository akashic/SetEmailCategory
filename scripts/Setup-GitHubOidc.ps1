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
    - Optionally writes the GitHub environment variables with the gh CLI.

    Requires: Azure CLI signed in as Owner (or User Access Administrator + Contributor) on the subscription/RG,
    and the gh CLI signed in with read access to the repo (or pass -OidcSubjectPrefix).

.EXAMPLE
    ./Setup-GitHubOidc.ps1 -SubscriptionId 0000... -ResourceGroup rg-setemailcat-prod -Location uksouth `
        -GitHubRepository WilliamBuckAustralia/SetEmailCategory -GitHubEnvironment prod -SetGitHubVariables
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

az account set --subscription $SubscriptionId
$tenantId = az account show --query tenantId -o tsv

if ((az group exists -n $ResourceGroup) -ne 'true') {
    if ($PSCmdlet.ShouldProcess($ResourceGroup, 'Create resource group')) {
        az group create -n $ResourceGroup -l $Location --only-show-errors | Out-Null
    }
}
$rgId = az group show -n $ResourceGroup --query id -o tsv

$identity = az identity list -g $ResourceGroup --query "[?name=='$IdentityName'] | [0]" --only-show-errors | ConvertFrom-Json
if (-not $identity) {
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
        Write-Host "Adding federated credential for $subject"
        az identity federated-credential create @fedArgs --name $fedName @issuerArgs | Out-Null
    }
    elseif ($named.subject -eq $legacySubject) {
        Write-Host "Updating federated credential '$fedName' from $($named.subject) to $subject"
        az identity federated-credential update @fedArgs --name $fedName @issuerArgs | Out-Null
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
    param([string] $Role, [string] $Condition)
    $existing = az role assignment list --assignee $identity.principalId --scope $rgId --role $Role --query '[].id' -o tsv
    if ($existing) { Write-Host "Already has '$Role'"; return }
    Write-Host "Granting '$Role' on $ResourceGroup"
    $roleArgs = @('role', 'assignment', 'create', '--assignee-object-id', $identity.principalId,
        '--assignee-principal-type', 'ServicePrincipal', '--role', $Role, '--scope', $rgId, '--only-show-errors')
    if ($Condition) { $roleArgs += @('--condition', $Condition, '--condition-version', '2.0') }
    az @roleArgs | Out-Null
}

Grant-Role 'Contributor'

# Constrained delegation: may only create/delete assignments of the listed roles, to service principals.
$condition = @"
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$AssignableRoles} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase 'ServicePrincipal')) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$AssignableRoles}))
"@
Grant-Role 'Role Based Access Control Administrator' $condition

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

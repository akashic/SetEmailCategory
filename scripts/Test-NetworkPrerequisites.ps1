#Requires -Version 7.2
<#
.SYNOPSIS
    Checks the private-networking settings in a parameter file against the Flex Consumption rules, William Buck
    policy and the existing Azure resources they name, before anything is deployed. Read-only; safe to re-run.

.DESCRIPTION
    Settings that can't work together:
      - existingAppSubnetId with createPrivateDnsZones = true. A VNet can be linked to only one private DNS zone
        of each name, so the template's zones would fail to link to the existing VNet or take over its storage
        name resolution from other workloads.
      - existing*PrivateDnsZoneId with createPrivateDnsZones = true, or only one of the two zone IDs.
      - The same subnet for both purposes.
    Existing resources:
      App subnet: exists; its VNet is readable and in the deployment region; NSG attached (William Buck policy);
        delegated to Microsoft.App/environments only; IPv4 range /27 or larger; no private or service endpoints;
        in another subscription, that subscription has Microsoft.Web registered.
      Private endpoint subnet: exists; its VNet is readable and in the region; NSG attached; not delegated.
      NSG: exists and is in the region.
      Private DNS zones: exist and are the privatelink.blob / privatelink.table zones for this cloud.
    Topology:
      - Subnets in different VNets must be peered (Connected).
      - With existing DNS zones, the app's VNet must be linked to both zones or use custom DNS servers (normally
        the hub's resolver).
      Either is a warning while the VNet the template creates doesn't exist yet (first deployment).
    Every problem is listed, then the script fails once.

    Setup-GitHubOidc.ps1 runs it before changing anything (Phase 3) and uses -PassThru to decide what to grant.
    The deploy workflow runs it before what-if (Phase 4).

    Requires: Azure CLI (with Bicep) signed in with read access to the existing resources.

.EXAMPLE
    ./Test-NetworkPrerequisites.ps1 -ParameterFile infra/env/prod.bicepparam -ResourceGroup rg-setemailcat-prod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ParameterFile,
    # The deployment RG. It holds the VNet the template creates, and gives the region if the file doesn't set one.
    [Parameter(Mandatory)] [string] $ResourceGroup,
    # Region to use when neither the file nor an existing RG gives one (Phase 3 can run before the RG exists).
    [string] $Location,
    # Also output the resolved settings.
    [switch] $PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$SubnetIdPattern = '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Network/virtualNetworks/[^/]+/subnets/[^/]+$'
$NsgIdPattern = '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Network/networkSecurityGroups/[^/]+$'
$ZoneIdPattern = '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Network/privateDnsZones/[^/]+$'
$FlexDelegation = 'Microsoft.App/environments'
$FlexMinimumPrefixLength = 27
$InGitHubActions = $env:GITHUB_ACTIONS -eq 'true'

# Missing properties are $null rather than an error under strict mode (az omits empty ones).
function Get-Prop($Object, [string] $Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name }
}

# Runs an az read command. Returns the parsed output, or $null with az's error in $script:AzError (not found, no
# access, expired sign-in...) so the caller can say why.
function Invoke-AzShow {
    $PSNativeCommandUseErrorActionPreference = $false
    $script:AzError = ''
    $output = @(az @args --only-show-errors -o json 2>&1)
    $stderr = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
    if ($LASTEXITCODE -ne 0) {
        $script:AzError = ($stderr -join ' ').Trim()
        if (-not $script:AzError) { $script:AzError = "az exited with code $LASTEXITCODE" }
        return $null
    }
    $json = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($json) { $json | ConvertFrom-Json }
}

function Get-Region([string] $Name) { ($Name -replace '\s', '').ToLowerInvariant() }

function Get-VnetId([string] $SubnetId) {
    $SubnetId.Substring(0, $SubnetId.IndexOf('/subnets/', [StringComparison]::OrdinalIgnoreCase))
}

function Add-Warning([string] $Message) {
    if ($InGitHubActions) { Write-Host "::warning::$Message" } else { Write-Warning $Message }
}

# ---------- Settings: the parameter file, else the template's literal defaults ----------

$compiled = az bicep build-params --file $ParameterFile --stdout --only-show-errors | ConvertFrom-Json
$fileParams = ($compiled.parametersJson | ConvertFrom-Json).parameters
$templateParams = ($compiled.templateJson | ConvertFrom-Json).parameters

function Get-Setting([string] $Name) {
    $param = Get-Prop $fileParams $Name
    if ($param) { return Get-Prop $param 'value' }
    $default = Get-Prop (Get-Prop $templateParams $Name) 'defaultValue'
    # An expression default (e.g. [resourceGroup().location]) has no value until deployment.
    if (-not ($default -is [string] -and $default.StartsWith('['))) { $default }
}

$fileLocation = Get-Setting 'location'
$rg = Invoke-AzShow group show -n $ResourceGroup
$resolvedLocation = if ($fileLocation) { $fileLocation } elseif ($rg) { $rg.location } elseif ($Location) { $Location }
if (-not $resolvedLocation) { throw "$ParameterFile doesn't set location and resource group $ResourceGroup doesn't exist. Pass -Location." }

$settings = [pscustomobject]@{
    PrivateNetworking       = [bool](Get-Setting 'enablePrivateNetworking')
    Location                = $resolvedLocation
    AppSubnetId             = [string](Get-Setting 'existingAppSubnetId')
    PrivateEndpointSubnetId = [string](Get-Setting 'existingPrivateEndpointSubnetId')
    NsgId                   = [string](Get-Setting 'existingNsgId')
    CreatePrivateDnsZones   = [bool](Get-Setting 'createPrivateDnsZones')
    BlobPrivateDnsZoneId    = [string](Get-Setting 'existingBlobPrivateDnsZoneId')
    TablePrivateDnsZoneId   = [string](Get-Setting 'existingTablePrivateDnsZoneId')
    VnetDnsServers          = @(Get-Setting 'vnetDnsServers')
}

if (-not $settings.PrivateNetworking) {
    Write-Host 'Private networking is off; no network settings to check.'
    if ($PassThru) { $settings }
    return
}

$region = Get-Region $settings.Location
$problems = [System.Collections.Generic.List[string]]::new()

# ---------- Settings that can't work together ----------

$zoneIds = @($settings.BlobPrivateDnsZoneId, $settings.TablePrivateDnsZoneId | Where-Object { $_ })
if ($settings.AppSubnetId -and $settings.CreatePrivateDnsZones) {
    $problems.Add('existingAppSubnetId needs createPrivateDnsZones = false. A VNet can be linked to only one private DNS zone of each name, so the template''s zones would fail to link to the existing VNet or take over its storage name resolution from other workloads. Use the hub''s zones (existingBlobPrivateDnsZoneId, existingTablePrivateDnsZoneId) or Azure Policy instead.')
}
if ($zoneIds.Count -eq 1) {
    $problems.Add('Set both existingBlobPrivateDnsZoneId and existingTablePrivateDnsZoneId, or neither: the function needs both storage services.')
}
if ($zoneIds.Count -and $settings.CreatePrivateDnsZones) {
    $problems.Add('existing*PrivateDnsZoneId needs createPrivateDnsZones = false; otherwise the template registers the endpoints in its own zones instead.')
}
if (-not $settings.CreatePrivateDnsZones -and -not $zoneIds.Count) {
    Add-Warning 'createPrivateDnsZones is false and no existing zones are set, so the template registers the storage private endpoints in no DNS zone. Azure Policy must do it, or the app can''t resolve storage and won''t start.'
}
if ($settings.AppSubnetId -and $settings.AppSubnetId -eq $settings.PrivateEndpointSubnetId) {
    $problems.Add('The app subnet and private endpoint subnet must be different: a subnet delegated to Flex Consumption can''t hold private endpoints.')
}

# ---------- Existing resources ----------

# Runs the checks both subnets share. Returns the subnet, its VNet, a display name and the delegations, or $null if
# it couldn't be read (already reported).
function Get-CheckedSubnet([string] $Id, [string] $Purpose) {
    if ($Id -notmatch $SubnetIdPattern) {
        $problems.Add("$Purpose subnet '$Id' isn't a subnet resource ID (/subscriptions/.../virtualNetworks/<vnet>/subnets/<subnet>).")
        return $null
    }
    $subnet = Invoke-AzShow network vnet subnet show --ids $Id
    if (-not $subnet) {
        $problems.Add("$Purpose subnet $Id can't be read: $script:AzError")
        return $null
    }
    $vnetId = Get-VnetId $Id
    $name = "$Purpose subnet $(($vnetId -split '/')[-1])/$($subnet.name)"

    $vnet = Invoke-AzShow network vnet show --ids $vnetId
    if (-not $vnet) {
        $problems.Add("Can't read the VNet of $name to check its region and peering ($script:AzError). The deployment identity needs Reader on it; Setup-GitHubOidc.ps1 grants that.")
    }
    elseif ((Get-Region $vnet.location) -ne $region) {
        $problems.Add("$name is in $($vnet.location); the function app is in $($settings.Location). They must be in the same region.")
    }
    if (-not (Get-Prop (Get-Prop $subnet 'networkSecurityGroup') 'id')) {
        $problems.Add("$name has no network security group. William Buck policy requires one on every subnet.")
    }
    [pscustomobject]@{
        Subnet      = $subnet
        Vnet        = $vnet
        Name        = $name
        Delegations = @(Get-Prop $subnet 'delegations' | ForEach-Object { Get-Prop $_ 'serviceName' })
    }
}

function Write-Ok([string] $Name, [int] $ProblemsBefore) {
    if ($problems.Count -eq $ProblemsBefore) { Write-Host "OK  $Name" -ForegroundColor Green }
}

$app = $null
$before = $problems.Count
if ($settings.AppSubnetId -and ($app = Get-CheckedSubnet $settings.AppSubnetId 'App')) {
    if ($app.Delegations.Count -ne 1 -or $app.Delegations[0] -ne $FlexDelegation) {
        $found = if ($app.Delegations) { $app.Delegations -join ', ' } else { 'none' }
        $problems.Add("$($app.Name) must be delegated to $FlexDelegation only (found: $found).")
    }
    # IPv6 ranges (dual-stack subnets) are always smaller than /27 in prefix terms, so only IPv4 is checked.
    $prefixes = @(@(Get-Prop $app.Subnet 'addressPrefix') + @(Get-Prop $app.Subnet 'addressPrefixes') |
        Where-Object { $_ -and $_ -notmatch ':' })
    foreach ($prefix in $prefixes) {
        if ([int]($prefix -split '/')[-1] -gt $FlexMinimumPrefixLength) {
            $problems.Add("$($app.Name) is $prefix; Flex Consumption needs /$FlexMinimumPrefixLength or larger.")
        }
    }
    foreach ($kind in 'privateEndpoints', 'serviceEndpoints') {
        if (@(Get-Prop $app.Subnet $kind | Where-Object { $_ }).Count) {
            $problems.Add("$($app.Name) has $kind; Flex Consumption needs a subnet used only for VNet integration.")
        }
    }
    # VNet integration across subscriptions needs the app's resource provider registered where the VNet is.
    $subnetSubscription = ($settings.AppSubnetId -split '/')[2]
    if ($subnetSubscription -ne (az account show --query id -o tsv)) {
        $provider = Invoke-AzShow provider show -n Microsoft.Web --subscription $subnetSubscription
        if (-not $provider) {
            Add-Warning "Couldn't check that Microsoft.Web is registered in subscription $subnetSubscription ($script:AzError). VNet integration with a subnet in another subscription needs it."
        }
        elseif ($provider.registrationState -ne 'Registered') {
            $problems.Add("Subscription $subnetSubscription, which holds $($app.Name), must have the Microsoft.Web resource provider registered (it's $($provider.registrationState)).")
        }
    }
    Write-Ok $app.Name $before
}

$pe = $null
$before = $problems.Count
if ($settings.PrivateEndpointSubnetId -and ($pe = Get-CheckedSubnet $settings.PrivateEndpointSubnetId 'Private endpoint')) {
    if ($pe.Delegations.Count) {
        $problems.Add("$($pe.Name) is delegated to $($pe.Delegations -join ', '); private endpoints need a subnet with no delegation.")
    }
    Write-Ok $pe.Name $before
}

if ($settings.NsgId) {
    if ($settings.NsgId -notmatch $NsgIdPattern) {
        $problems.Add("NSG '$($settings.NsgId)' isn't a network security group resource ID (/subscriptions/.../networkSecurityGroups/<name>).")
    }
    elseif (-not ($nsg = Invoke-AzShow network nsg show --ids $settings.NsgId)) {
        $problems.Add("NSG $($settings.NsgId) can't be read: $script:AzError")
    }
    elseif ((Get-Region $nsg.location) -ne $region) {
        $problems.Add("NSG $($nsg.name) is in $($nsg.location); it must be in $($settings.Location) to attach to the template's subnets.")
    }
    else {
        Write-Host "OK  NSG $($nsg.name)" -ForegroundColor Green
    }
}

$storageSuffix = az cloud show --query suffixes.storageEndpoint -o tsv
$zones = @()
foreach ($zone in @{ Service = 'blob'; Param = 'existingBlobPrivateDnsZoneId'; Id = $settings.BlobPrivateDnsZoneId },
    @{ Service = 'table'; Param = 'existingTablePrivateDnsZoneId'; Id = $settings.TablePrivateDnsZoneId }) {
    if (-not $zone.Id) { continue }
    $expected = "privatelink.$($zone.Service).$storageSuffix"
    if ($zone.Id -notmatch $ZoneIdPattern) {
        $problems.Add("$($zone.Service) zone '$($zone.Id)' isn't a private DNS zone resource ID (/subscriptions/.../privateDnsZones/$expected).")
    }
    elseif (($zone.Id -split '/')[-1] -ne $expected) {
        $problems.Add("$($zone.Param) must be a $expected zone, not $(($zone.Id -split '/')[-1]).")
    }
    elseif (-not (Invoke-AzShow network private-dns zone show --ids $zone.Id)) {
        $problems.Add("Private DNS zone $($zone.Id) can't be read: $script:AzError")
    }
    else {
        Write-Host "OK  Private DNS zone $expected" -ForegroundColor Green
        $zones += $zone.Id
    }
}

# ---------- Topology ----------

# The VNet the template creates (vnet-<workload>-<env>-<suffix>), once a deployment has created it.
$templateVnet = $null
if ($rg -and -not ($settings.AppSubnetId -and $settings.PrivateEndpointSubnetId)) {
    $prefix = "vnet-$(Get-Setting 'workload')-$(Get-Setting 'environmentName')-"
    $templateVnet = @(Invoke-AzShow network vnet list -g $ResourceGroup) |
        Where-Object { $_ -and $_.name.StartsWith($prefix) } | Select-Object -First 1
}
$appVnet = if ($settings.AppSubnetId) { if ($app) { $app.Vnet } } else { $templateVnet }
$peVnet = if ($settings.PrivateEndpointSubnetId) { if ($pe) { $pe.Vnet } } else { $templateVnet }
$waitingForTemplateVnet = -not $templateVnet -and -not ($settings.AppSubnetId -and $settings.PrivateEndpointSubnetId)

if ($appVnet -and $peVnet) {
    if ($appVnet.id -ne $peVnet.id) {
        $peering = @(Get-Prop $appVnet 'virtualNetworkPeerings') | Where-Object {
            $_ -and (Get-Prop (Get-Prop $_ 'remoteVirtualNetwork') 'id') -eq $peVnet.id -and (Get-Prop $_ 'peeringState') -eq 'Connected'
        }
        if ($peering) { Write-Host "OK  $($appVnet.name) is peered with $($peVnet.name)" -ForegroundColor Green }
        else {
            $problems.Add("VNets $($appVnet.name) (app) and $($peVnet.name) (private endpoints) aren't peered, or the peering isn't Connected, so the app can't reach storage.")
        }
    }
}
elseif ($waitingForTemplateVnet -and ($settings.AppSubnetId -or $settings.PrivateEndpointSubnetId)) {
    Add-Warning ('Only one existing subnet is configured, so the template creates the other in a new VNet, which doesn''t exist yet. ' +
        'Peer the two VNets after this deployment, then deploy again; until then the app can''t reach storage (docs/RUNBOOK.md, "Private networking").')
}

if ($zones.Count -eq 2) {
    if ($appVnet) {
        # The template's VNet gets the DNS servers in the parameter file on this deployment.
        $dnsServers = if ($settings.AppSubnetId) { @(Get-Prop (Get-Prop $appVnet 'dhcpOptions') 'dnsServers') } else { $settings.VnetDnsServers }
        if (@($dnsServers | Where-Object { $_ }).Count) {
            Write-Host "OK  $($appVnet.name) uses custom DNS servers ($($dnsServers -join ', ')); they must resolve the hub zones." -ForegroundColor Green
        }
        else {
            foreach ($zoneId in $zones) {
                $parts = $zoneId -split '/'
                $links = Invoke-AzShow network private-dns link vnet list -g $parts[4] -z $parts[-1] --subscription $parts[2]
                if ($script:AzError) {
                    $problems.Add("Can't read the VNet links of zone $($parts[-1]) ($script:AzError).")
                }
                elseif (-not (@($links) | Where-Object { $_ -and (Get-Prop (Get-Prop $_ 'virtualNetwork') 'id') -eq $appVnet.id })) {
                    $problems.Add("$($appVnet.name) uses Azure-provided DNS but isn't linked to $($parts[-1]), so the app can't resolve storage. Ask the zone's owners to link it, or set vnetDnsServers to the hub's resolver.")
                }
            }
        }
    }
    elseif ($waitingForTemplateVnet -and -not $settings.AppSubnetId -and -not $settings.VnetDnsServers.Count) {
        Add-Warning ('The template''s VNet doesn''t exist yet and vnetDnsServers is empty. After this deployment, have the hub zones linked to it ' +
            '(or set vnetDnsServers to the hub''s resolver), or the app can''t resolve storage.')
    }
}

if ($problems.Count) {
    if ($InGitHubActions) { $problems | ForEach-Object { Write-Host "::error::$_" } }
    throw "Network prerequisites not met:`n - $($problems -join "`n - ")"
}
Write-Host 'Network settings OK.' -ForegroundColor Green
if ($PassThru) { $settings }

using '../main.bicep'

// Values marked <...> come from scripts/Setup-EntraApps.ps1 output (entra-output.json).
param environmentName = 'prod'

// Set explicitly (docs/AZURE-DEPLOYMENT-SETUP.md, answer A2) rather than inherited from the platform team's RG.
param location = 'australiaeast'
param sharedMailboxAddress = '<shared-mailbox@contoso.com>'
param apiAppClientId = '<api app registration client id>'
param allowedClientApplicationIds = [
  '<connector app registration client id>'
]

param tags = {
  owner: '<team or distribution list>'
  costCenter: '<cost centre>'
}

// Azure Policy requires private storage (docs/AZURE-DEPLOYMENT-SETUP.md, answer A6; see docs/RUNBOOK.md,
// "Private networking"). William Buck policy requires an NSG on every subnet: the template attaches one to each
// subnet it creates, and existing subnets must already have one.
param enablePrivateNetworking = true

// An existing subnet is being re-used (A11). Set the one(s) that exist; Setup-GitHubOidc.ps1 reads this file to
// grant access to them. The template creates any subnet left unset in a new VNet; if only one is set, the two
// VNets must be peered. Each value is a full resource ID, e.g.
// /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>
// param existingAppSubnetId = ''             // delegated to Microsoft.App/environments, /27 or larger
// param existingPrivateEndpointSubnetId = '' // not delegated
// param existingNsgId = ''                   // optional: attach this NSG to created subnets instead of new ones

// Private DNS (A8, still open). An existing app subnet requires createPrivateDnsZones = false: a VNet can be linked
// to only one zone of each name. Then either name the hub's zones so the endpoints are registered there, or leave
// them unset and rely on Azure Policy. vnetDnsServers points a VNet the template creates at the hub's resolver.
// param createPrivateDnsZones = false
// param existingBlobPrivateDnsZoneId = ''    // .../privateDnsZones/privatelink.blob.core.windows.net
// param existingTablePrivateDnsZoneId = ''   // .../privateDnsZones/privatelink.table.core.windows.net
// param vnetDnsServers = []

// Ranges for the subnets the template creates, from IPAM (A8, still open); placeholders keep the template's
// 10.60.0.0/24 defaults from being deployed by accident. Delete the prefix of any subnet supplied above, and all
// three lines if both are.
param vnetAddressPrefix = '<VNet CIDR from IPAM>'
param appSubnetPrefix = '<app subnet CIDR inside the VNet, e.g. a /26>'
param privateEndpointSubnetPrefix = '<private endpoint subnet CIDR inside the VNet, e.g. a /27>'

// 1 removes cold starts (adds a small always-on cost). 0 scales to zero.
param alwaysReadyInstances = 0

// Who gets emailed when requests fail. Empty list = no alerts.
param alertEmailAddresses = [
  '<ops-team@contoso.com>'
]

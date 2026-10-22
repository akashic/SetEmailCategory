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
// "Private networking").
param enablePrivateNetworking = true

// Both subnets already exist in the platform team's shared VNet (A11), so the template creates no VNet, subnets
// or NSGs; the platform team's subnets carry the NSGs William Buck policy requires (A10). Full resource IDs, e.g.
// /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>.
// Setup-GitHubOidc.ps1 reads them from this file to grant the deployment access.
param existingAppSubnetId = '<app subnet resource ID: delegated to Microsoft.App/environments, /27 or larger>'
param existingPrivateEndpointSubnetId = '<private endpoint subnet resource ID: not delegated>'

// The VNet is shared, so the template mustn't create its own privatelink zones: a VNet can be linked to only one
// zone of each name. How private DNS is managed is still open (docs/openquestions.md, N2): name the hub's zones
// below, or leave them unset if an Azure Policy registers private endpoints in them.
param createPrivateDnsZones = false
// param existingBlobPrivateDnsZoneId = ''    // .../privateDnsZones/privatelink.blob.core.windows.net
// param existingTablePrivateDnsZoneId = ''   // .../privateDnsZones/privatelink.table.core.windows.net

// 1 removes cold starts (adds a small always-on cost). 0 scales to zero.
param alwaysReadyInstances = 0

// Who gets emailed when requests fail. Empty list = no alerts.
param alertEmailAddresses = [
  '<ops-team@contoso.com>'
]

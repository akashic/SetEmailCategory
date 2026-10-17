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
// "Private networking"). The VNet ranges come from IPAM (A8, still open); placeholders keep the template's
// 10.60.0.0/24 defaults from being deployed by accident. The defaults use a /26 app subnet and a /27 private
// endpoint subnet, both inside the VNet range.
param enablePrivateNetworking = true
param vnetAddressPrefix = '<VNet CIDR from IPAM>'
param appSubnetPrefix = '<app subnet CIDR inside the VNet, e.g. a /26>'
param privateEndpointSubnetPrefix = '<private endpoint subnet CIDR inside the VNet, e.g. a /27>'

// 1 removes cold starts (adds a small always-on cost). 0 scales to zero.
param alwaysReadyInstances = 0

// Who gets emailed when requests fail. Empty list = no alerts.
param alertEmailAddresses = [
  '<ops-team@contoso.com>'
]

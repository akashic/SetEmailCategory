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
// "Private networking"). Hub peering, central DNS and the VNet range (A8) are still open, so the defaults below
// apply until they're answered: a standalone 10.60.0.0/24 VNet with its own privatelink DNS zones.
param enablePrivateNetworking = true

// 1 removes cold starts (adds a small always-on cost). 0 scales to zero.
param alwaysReadyInstances = 0

// Who gets emailed when requests fail. Empty list = no alerts.
param alertEmailAddresses = [
  '<ops-team@contoso.com>'
]

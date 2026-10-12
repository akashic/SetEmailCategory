using '../main.bicep'

// Values marked <...> come from scripts/Setup-EntraApps.ps1 output (entra-output.json).
param environmentName = 'prod'
param sharedMailboxAddress = '<shared-mailbox@contoso.com>'
param apiAppClientId = '<api app registration client id>'
param allowedClientApplicationIds = [
  '<connector app registration client id>'
]

param tags = {
  owner: '<team or distribution list>'
  costCenter: '<cost centre>'
}

// Set true if storage must not be publicly reachable (see docs/RUNBOOK.md, "Private networking").
param enablePrivateNetworking = false

// 1 removes cold starts (adds a small always-on cost). 0 scales to zero.
param alwaysReadyInstances = 0

// Who gets emailed when requests fail. Empty list = no alerts.
param alertEmailAddresses = [
  '<ops-team@contoso.com>'
]

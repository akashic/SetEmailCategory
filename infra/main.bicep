// SetEmailCategory - Azure Function that sets Outlook categories on messages in a shared mailbox.
// Deploys into an existing resource group (corporate platform teams usually own RG creation and policy).
targetScope = 'resourceGroup'

// ---------- Naming & placement ----------

@description('Short workload name used in resource names (lowercase letters and digits).')
@minLength(3)
@maxLength(12)
param workload string = 'setemailcat'

@description('Environment name, e.g. dev, test, prod.')
@allowed(['dev', 'test', 'prod'])
param environmentName string

@description('Azure region. Must support the Flex Consumption plan (az functionapp list-flexconsumption-locations).')
param location string = resourceGroup().location

@description('Tags applied to every resource.')
param tags object = {}

// ---------- Application ----------

@description('SMTP address of the shared mailbox the function may modify. Must match the Exchange RBAC management scope.')
param sharedMailboxAddress string

@description('Application (client) ID of the Entra app registration that represents this API (output of scripts/Setup-EntraApps.ps1).')
param apiAppClientId string

@description('Client IDs allowed to call the API (the custom connector app registration). Tokens issued to any other client are rejected.')
param allowedClientApplicationIds array

// ---------- Scale ----------

@description('Instance memory in MB. 512 is ample for this workload.')
@allowed([512, 2048, 4096])
param instanceMemoryMB int = 512

@description('Maximum instances. Microsoft advises at least 40 for HTTP apps: below that, bursts beyond capacity are rejected by the platform before reaching the code. Graph concurrency is limited separately (graphConcurrencyPerInstance).')
@minValue(40)
@maxValue(1000)
param maximumInstanceCount int = 40

@description('Concurrent HTTP requests per instance. Flex adds instances only when in-flight requests exceed this per instance, and the Graph limit is enforced per instance, so a high value keeps bursts on one instance (one Graph gate) instead of multiplying Graph concurrency. Requests are I/O-bound and wait in-process for a Graph slot.')
@minValue(1)
@maxValue(1000)
param httpPerInstanceConcurrency int = 50

@description('Concurrent Microsoft Graph requests per instance. Graph allows 4 per app per mailbox; anything above that is throttled (429) and retried. Per instance: if the app scales to N instances the total can reach N x this value.')
@minValue(1)
@maxValue(16)
param graphConcurrencyPerInstance int = 4

@description('Per-invocation time budget in seconds, including Graph retries. Must stay below Power Automate\'s 120-second limit for synchronous calls.')
@minValue(10)
@maxValue(110)
param requestDeadlineSeconds int = 90

@description('Always-ready instances for the HTTP trigger group. 0 = scale to zero (cheapest, cold starts); 1 = no cold starts (billed continuously).')
@minValue(0)
param alwaysReadyInstances int = 0

// ---------- Networking ----------

@description('When true: storage is reachable only through private endpoints and the function app egresses through a VNet. Inbound to the function stays public (Power Platform must reach it), protected by Entra ID.')
param enablePrivateNetworking bool = false

@description('Resource ID of an existing subnet for Flex Consumption VNet integration. It must be in the app\'s region, delegated to Microsoft.App/environments, at least /27, with an NSG attached and no private or service endpoints. Empty = the template creates one. scripts/Test-NetworkPrerequisites.ps1 checks these rules.')
param existingAppSubnetId string = ''

@description('Resource ID of an existing subnet for the storage private endpoints. It must be in the app\'s region, not delegated, with an NSG attached. Empty = the template creates one.')
param existingPrivateEndpointSubnetId string = ''

@description('Resource ID of an existing NSG to attach to the subnets the template creates (William Buck policy requires an NSG on every subnet). Empty = the template creates one NSG per subnet, with Azure\'s default rules only. Not applied to existing subnets, which keep their own.')
param existingNsgId string = ''

@description('Address space for the VNet the template creates when private networking needs a subnet that wasn\'t supplied.')
param vnetAddressPrefix string = '10.60.0.0/24'

@description('Subnet for Flex Consumption VNet integration (delegated to Microsoft.App/environments). Ignored when existingAppSubnetId is set.')
param appSubnetPrefix string = '10.60.0.0/26'

@description('Subnet for private endpoints. Ignored when existingPrivateEndpointSubnetId is set.')
param privateEndpointSubnetPrefix string = '10.60.0.64/27'

@description('Create privatelink DNS zones in this resource group and link them to the app\'s VNet. Set false where a hub/landing zone manages private DNS centrally, and always when existingAppSubnetId is set: a VNet can be linked to only one zone of each name, so linking ours to a shared VNet fails or hijacks other workloads\' storage name resolution.')
param createPrivateDnsZones bool = true

@description('Resource ID of an existing privatelink.blob zone (e.g. the hub\'s) to register the blob private endpoint in. Use with existingTablePrivateDnsZoneId and createPrivateDnsZones = false. Empty = no DNS zone group, so the records come from createPrivateDnsZones or Azure Policy.')
param existingBlobPrivateDnsZoneId string = ''

@description('Resource ID of an existing privatelink.table zone. See existingBlobPrivateDnsZoneId.')
param existingTablePrivateDnsZoneId string = ''

@description('Custom DNS servers for the VNet the template creates, e.g. the hub\'s DNS resolver, so it can resolve existing (hub) private DNS zones. Empty = Azure-provided DNS.')
param vnetDnsServers array = []

// ---------- Monitoring ----------

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 90

@description('Email addresses notified by the failure alerts (500/502, sustained 503s, and caller errors 400/409/413). Empty = no alerting resources are created.')
param alertEmailAddresses array = []

@description('Alert when more than this many 503 responses occur in 15 minutes. A few are normal during bursts: Graph throttles and Power Automate retries.')
@minValue(0)
param throttlingAlertThreshold int = 10

// ---------- Names ----------

var suffix = take(uniqueString(resourceGroup().id, workload, environmentName), 6)
var baseName = '${workload}-${environmentName}-${suffix}'
var names = {
  logAnalytics: 'log-${baseName}'
  appInsights: 'appi-${baseName}'
  storage: take('st${replace(workload, '-', '')}${environmentName}${suffix}', 24)
  plan: 'asp-${baseName}'
  functionApp: 'func-${baseName}'
  vnet: 'vnet-${baseName}'
  appNsg: 'nsg-${baseName}-app'
  privateEndpointNsg: 'nsg-${baseName}-pe'
}
var allTags = union(tags, {
  workload: workload
  environment: environmentName
})
var deploymentContainerName = 'app-package'

// Private networking uses an existing subnet where one is supplied and creates the rest in a new VNet. If only one
// subnet is supplied, the two end up in different VNets, which must be peered (docs/RUNBOOK.md, "Private networking").
var createAppSubnet = enablePrivateNetworking && empty(existingAppSubnetId)
var createPrivateEndpointSubnet = enablePrivateNetworking && empty(existingPrivateEndpointSubnetId)
var appSubnetId = !enablePrivateNetworking ? '' : createAppSubnet ? network!.outputs.appSubnetId : existingAppSubnetId
var privateEndpointSubnetId = !enablePrivateNetworking
  ? ''
  : createPrivateEndpointSubnet ? network!.outputs.privateEndpointSubnetId : existingPrivateEndpointSubnetId
// The private DNS zones must resolve where the app's outbound traffic comes from: the app subnet's VNet. indexOf is
// case-insensitive, like resource IDs, so an ID pasted as .../Subnets/... still yields the VNet.
var appVnetId = empty(appSubnetId) ? '' : substring(appSubnetId, 0, indexOf(appSubnetId, '/subnets/'))

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    tags: allTags
    logAnalyticsName: names.logAnalytics
    appInsightsName: names.appInsights
    retentionInDays: logRetentionDays
  }
}

module network 'modules/network.bicep' = if (createAppSubnet || createPrivateEndpointSubnet) {
  name: 'network'
  params: {
    location: location
    tags: allTags
    vnetName: names.vnet
    vnetAddressPrefix: vnetAddressPrefix
    appSubnetPrefix: appSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    createAppSubnet: createAppSubnet
    createPrivateEndpointSubnet: createPrivateEndpointSubnet
    existingNsgId: existingNsgId
    dnsServers: vnetDnsServers
    appNsgName: names.appNsg
    privateEndpointNsgName: names.privateEndpointNsg
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    tags: allTags
    storageAccountName: names.storage
    deploymentContainerName: deploymentContainerName
    enablePrivateNetworking: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    vnetId: appVnetId
    createPrivateDnsZones: createPrivateDnsZones
    existingPrivateDnsZoneIds: [existingBlobPrivateDnsZoneId, existingTablePrivateDnsZoneId]
  }
}

module functionApp 'modules/functionApp.bicep' = {
  name: 'functionApp'
  params: {
    location: location
    tags: allTags
    planName: names.plan
    functionAppName: names.functionApp
    storageAccountName: storage.outputs.name
    deploymentContainerUrl: '${storage.outputs.blobEndpoint}${deploymentContainerName}'
    appInsightsName: monitoring.outputs.appInsightsName
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    instanceMemoryMB: instanceMemoryMB
    maximumInstanceCount: maximumInstanceCount
    httpPerInstanceConcurrency: httpPerInstanceConcurrency
    alwaysReadyInstances: alwaysReadyInstances
    graphConcurrencyPerInstance: graphConcurrencyPerInstance
    requestDeadlineSeconds: requestDeadlineSeconds
    appSubnetId: appSubnetId
    sharedMailboxAddress: sharedMailboxAddress
    apiAppClientId: apiAppClientId
    allowedClientApplicationIds: allowedClientApplicationIds
  }
}

module alerts 'modules/alerts.bicep' = if (!empty(alertEmailAddresses)) {
  name: 'alerts'
  params: {
    location: location
    tags: allTags
    namePrefix: baseName
    appInsightsName: monitoring.outputs.appInsightsName
    emailAddresses: alertEmailAddresses
    throttlingThreshold: throttlingAlertThreshold
  }
}

output functionAppName string = functionApp.outputs.name
output functionAppHostName string = functionApp.outputs.defaultHostName
@description('Object ID of the function app managed identity. Feed this to scripts/Grant-MailboxAccess.ps1.')
output functionAppPrincipalId string = functionApp.outputs.principalId
output appInsightsName string = monitoring.outputs.appInsightsName

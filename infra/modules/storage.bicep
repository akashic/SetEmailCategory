param location string
param tags object
param storageAccountName string
param deploymentContainerName string
param enablePrivateNetworking bool
param privateEndpointSubnetId string
@description('VNet the private DNS zones are linked to: the one the function app integrates with.')
param vnetId string
param createPrivateDnsZones bool
@description('Existing zone IDs in privateServices order (blob, table). Used for the DNS zone groups when createPrivateDnsZones is false; an empty entry means no zone group for that service.')
param existingPrivateDnsZoneIds array

// The Functions host uses blob (leases, keys, deployment package) and table (diagnostic events). Queue storage is
// only used by blob triggers, Durable Functions and some trigger retries, none of which this HTTP-only app has.
var privateServices = ['blob', 'table']

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Keys are disabled; the function app uses its managed identity for every storage operation.
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: enablePrivateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }

  resource blobService 'blobServices' = {
    name: 'default'

    resource deploymentContainer 'containers' = {
      name: deploymentContainerName
    }
  }
}

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for service in privateServices: if (enablePrivateNetworking && createPrivateDnsZones) {
    name: 'privatelink.${service}.${environment().suffixes.storage}'
    location: 'global'
    tags: tags
  }
]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (service, i) in privateServices: if (enablePrivateNetworking && createPrivateDnsZones) {
    parent: dnsZones[i]
    name: 'link-${uniqueString(vnetId)}'
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: vnetId
      }
    }
  }
]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [
  for service in privateServices: if (enablePrivateNetworking) {
    name: 'pe-${storageAccountName}-${service}'
    location: location
    tags: tags
    properties: {
      subnet: {
        id: privateEndpointSubnetId
      }
      privateLinkServiceConnections: [
        {
          name: service
          properties: {
            privateLinkServiceId: storage.id
            groupIds: [service]
          }
        }
      ]
    }
  }
]

resource dnsZoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
  for (service, i) in privateServices: if (enablePrivateNetworking && (createPrivateDnsZones || !empty(existingPrivateDnsZoneIds[i]))) {
    parent: privateEndpoints[i]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: service
          properties: {
            privateDnsZoneId: createPrivateDnsZones ? dnsZones[i].id : existingPrivateDnsZoneIds[i]
          }
        }
      ]
    }
  }
]

output name string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob

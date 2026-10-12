param location string
param tags object
param storageAccountName string
param deploymentContainerName string
param enablePrivateNetworking bool
param privateEndpointSubnetId string
param vnetId string
param createPrivateDnsZones bool

// The Functions host uses blob (leases, keys, deployment package), queue and table services.
var privateServices = ['blob', 'queue', 'table']

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
  for (service, i) in privateServices: if (enablePrivateNetworking && createPrivateDnsZones) {
    parent: privateEndpoints[i]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: service
          properties: {
            privateDnsZoneId: dnsZones[i].id
          }
        }
      ]
    }
  }
]

output name string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob

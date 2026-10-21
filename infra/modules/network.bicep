// Creates the subnets that main.bicep wasn't given existing IDs for, in a new VNet. William Buck policy requires a
// network security group on every subnet, so each subnet created here gets one: existingNsgId if set, otherwise its own.
param location string
param tags object
param vnetName string
param vnetAddressPrefix string
param appSubnetPrefix string
param privateEndpointSubnetPrefix string
param createAppSubnet bool
param createPrivateEndpointSubnet bool
@description('NSG attached to every subnet created here. Empty = one NSG per subnet, with Azure\'s default rules only.')
param existingNsgId string
@description('Custom DNS servers for the VNet. Empty = Azure-provided DNS.')
param dnsServers array
param appNsgName string
param privateEndpointNsgName string

var appSubnetName = 'snet-app'
var privateEndpointSubnetName = 'snet-private-endpoints'

resource appNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createAppSubnet && empty(existingNsgId)) {
  name: appNsgName
  location: location
  tags: tags
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createPrivateEndpointSubnet && empty(existingNsgId)) {
  name: privateEndpointNsgName
  location: location
  tags: tags
}

// Subnets are declared inline so each is created with its NSG already attached; a policy that denies subnets
// without one evaluates the subnet at creation, so attaching it afterwards would be too late.
var appSubnet = {
  name: appSubnetName
  properties: {
    addressPrefix: appSubnetPrefix
    networkSecurityGroup: {
      id: empty(existingNsgId) ? appNsg.id : existingNsgId
    }
    // Flex Consumption VNet integration requires this delegation (and the Microsoft.App resource provider).
    delegations: [
      {
        name: 'flex-consumption'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

var privateEndpointSubnet = {
  name: privateEndpointSubnetName
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    networkSecurityGroup: {
      id: empty(existingNsgId) ? privateEndpointNsg.id : existingNsgId
    }
    // Without this, NSG rules don't apply to private endpoint traffic and the NSG is attached in name only.
    privateEndpointNetworkPolicies: 'NetworkSecurityGroupEnabled'
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    dhcpOptions: empty(dnsServers) ? null : { dnsServers: dnsServers }
    // Subnets are declared inline, so a redeploy removes any subnet not listed here, including one created earlier
    // and since replaced by an existing subnet (see docs/RUNBOOK.md, "Private networking").
    subnets: concat(createAppSubnet ? [appSubnet] : [], createPrivateEndpointSubnet ? [privateEndpointSubnet] : [])
  }
}

output vnetId string = vnet.id
output appSubnetId string = createAppSubnet ? '${vnet.id}/subnets/${appSubnetName}' : ''
output privateEndpointSubnetId string = createPrivateEndpointSubnet ? '${vnet.id}/subnets/${privateEndpointSubnetName}' : ''

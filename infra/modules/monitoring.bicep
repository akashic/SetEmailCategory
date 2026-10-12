param location string
param tags object
param logAnalyticsName string
param appInsightsName string
param retentionInDays int

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    // Ingestion requires Entra ID (the function's managed identity); instrumentation keys alone are rejected.
    DisableLocalAuth: true
  }
}

output appInsightsName string = appInsights.name
output logAnalyticsWorkspaceId string = logAnalytics.id

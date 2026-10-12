param tags object
param namePrefix string
param appInsightsName string
param emailAddresses array

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('setemailcat', 12)
    enabled: true
    emailReceivers: [
      for (address, i) in emailAddresses: {
        name: 'email-${i}'
        emailAddress: address
        useCommonAlertSchema: true
      }
    ]
  }
}

// Application Insights counts any response >= 400 as failed, so this fires on caller errors (e.g. 404 message
// not found) as well as server errors. For a low-volume integration both are worth a look.
resource failedRequests 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${namePrefix}-failed-requests'
  location: 'global'
  tags: tags
  properties: {
    description: 'SetEmailCategory returned failed responses. Check Application Insights > Failures.'
    severity: 2
    enabled: true
    scopes: [appInsights.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failed-requests'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'requests/failed'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Count'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

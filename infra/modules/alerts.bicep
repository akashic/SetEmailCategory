param location string
param tags object
param namePrefix string
param appInsightsName string
param emailAddresses array
param throttlingThreshold int

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

// Log search alerts on the requests table, split by status code, so each alert covers only the codes that need
// that response. (The requests/failed metric counts 4xx and 5xx alike, including routine 404s and the 503s that
// Power Automate retries successfully.) 401/403 never reach the function: Easy Auth answers them first.
var rules = [
  {
    name: 'server-errors'
    description: 'SetEmailCategory returned 500 or 502: a misconfiguration (e.g. App Service Authentication disabled, mailbox access missing) or a bug. Retries will not fix it. See docs/RUNBOOK.md troubleshooting.'
    severity: 2
    resultCodes: ['500', '502']
    threshold: 0
    windowSize: 'PT15M'
    evaluationFrequency: 'PT5M'
  }
  {
    // A few 503s are normal during bursts (Graph throttling, retried by Power Automate); only sustained ones matter.
    name: 'graph-throttling'
    description: 'SetEmailCategory returned more than ${throttlingThreshold} 503s in 15 minutes: Microsoft Graph is throttling or unavailable for longer than retries can absorb.'
    severity: 2
    resultCodes: ['503']
    threshold: throttlingThreshold
    windowSize: 'PT15M'
    evaluationFrequency: 'PT5M'
  }
  {
    // 404 is left out: messages deleted before the flow runs make it routine.
    name: 'caller-errors'
    description: 'SetEmailCategory returned 400, 409 or 413: a flow is sending invalid input. Check the flow run and the response detail.'
    severity: 3
    resultCodes: ['400', '409', '413']
    threshold: 0
    windowSize: 'PT1H'
    evaluationFrequency: 'PT15M'
  }
]

resource requestAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [
  for rule in rules: {
    name: 'alert-${namePrefix}-${rule.name}'
    location: location
    tags: tags
    kind: 'LogAlert'
    properties: {
      displayName: 'alert-${namePrefix}-${rule.name}'
      description: rule.description
      severity: rule.severity
      enabled: true
      scopes: [appInsights.id]
      evaluationFrequency: rule.evaluationFrequency
      windowSize: rule.windowSize
      criteria: {
        allOf: [
          {
            // sum(itemCount) keeps the count right if sampling is ever enabled.
            query: 'requests | where resultCode in (${join(map(rule.resultCodes, code => '"${code}"'), ', ')}) | summarize responses = sum(itemCount) by resultCode'
            timeAggregation: 'Total'
            metricMeasureColumn: 'responses'
            dimensions: [
              {
                name: 'resultCode'
                operator: 'Include'
                values: ['*']
              }
            ]
            operator: 'GreaterThan'
            threshold: rule.threshold
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      autoMitigate: true
      actions: {
        actionGroups: [actionGroup.id]
      }
    }
  }
]

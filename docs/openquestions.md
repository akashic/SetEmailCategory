# Open questions: networking

Networking questions that must be answered before the first production deployment with private networking. The IDs (A6, A8, A10, A11) refer to the decisions in [AZURE-DEPLOYMENT-SETUP.md](AZURE-DEPLOYMENT-SETUP.md#1-environment-decisions); the settings are explained in [RUNBOOK.md, Private networking](RUNBOOK.md#private-networking). Most questions are for William Buck's platform or network team.

Raised 2026-10-22. Record answers in the decisions table, then delete them here.

## Blocking: the deployment can't be configured without these

| # | Question | Why it matters | Once answered |
|---|---|---|---|
| N1 | **Which subnet is being re-used, and what is it for?** Its full resource ID, and whether it's for the function's VNet integration (app subnet) or for the storage private endpoints. Is there a second existing subnet for the other role? (A11) | The two roles have different rules, and the template creates whichever subnet isn't supplied. | Set `existingAppSubnetId` and/or `existingPrivateEndpointSubnetId` in `prod.bicepparam`. |
| N2 | **How is `privatelink.blob` and `privatelink.table` DNS managed?** The hub zones' resource IDs; whether an Azure Policy registers new private endpoints in them automatically; and whether the existing subnet's VNet is linked to those zones or uses the hub's DNS resolver (its IP). (A8) | Re-using an app subnet rules out the template's own DNS zones (a VNet can be linked to only one zone of each name). Without the hub zones or a policy, the app can't resolve storage and won't start. | Set `createPrivateDnsZones = false`, then either `existingBlobPrivateDnsZoneId` and `existingTablePrivateDnsZoneId`, or rely on the policy. Set `vnetDnsServers` to the resolver IP if the template creates a VNet. |
| N3 | **IP ranges from IPAM** for any VNet and subnets the template still creates: a VNet range, plus a /26 app subnet and/or a /27 private endpoint subnet inside it, not overlapping anything it will be peered with. (A8) | The deploy job stops while the placeholders remain. Not needed if both subnets already exist. | Set `vnetAddressPrefix` and the matching `*SubnetPrefix`; delete the lines for supplied subnets. |
| N4 | **If only one subnet exists: who peers the template's new VNet with the existing VNet (or the hub), and when?** | Until the VNets are peered, the app can't reach storage. The first deployment creates the VNet, then peering has to happen before a second deployment. | Plan the peering step into the first deployment, or supply both subnets so no new VNet is needed. |
| N5 | **Who will run `Setup-GitHubOidc.ps1` for the network resources?** They need Owner or User Access Administrator on the existing subnet's resource group (and on the DNS zones' resource group if N2 names hub zones), plus permission to create a custom role there. | The deployment identity can't attach to resources outside its resource group without these grants. | Agree a session with the network team; send them the `-WhatIf` preview first. |

## Needed to confirm the design

| # | Question | Why it matters | Once answered |
|---|---|---|---|
| N6 | **Is a custom role acceptable?** The script creates *SetEmailCategory Network Join* (read and join subnets and NSGs only). If custom roles aren't allowed, it can grant the built-in Network Contributor instead, which also lets the pipeline change the subnet. | Least privilege versus what the organisation allows. | If not allowed, run the script with `-UseBuiltInNetworkRole`. |
| N7 | **Does the existing subnet meet the Flex Consumption rules?** In Australia East; delegated to `Microsoft.App/environments` only; /27 or larger (/26 if other Flex apps share it); no private or service endpoints; an NSG attached. Is it already used by other apps? | The deployment fails on a subnet that breaks these rules; a subnet shared with other apps shares their network capacity. | `Test-NetworkPrerequisites.ps1` confirms it once N1 is set; the network team fixes any gaps. |
| N8 | **Is the existing subnet in the same subscription as the function app?** If not, is `Microsoft.Web` registered in that subscription? | VNet integration across subscriptions needs it registered there. | The check script reports it; register the provider if needed. |
| N9 | **NSG rule details (A10).** Does the policy accept the NSGs the template creates (Azure's default rules only), or must subnets use a central NSG? Are custom rules, NSG flow logs or diagnostic settings also required? Is the policy *deny* or *audit*? | The template attaches its own NSGs unless `existingNsgId` is set; extra requirements need template changes. | Set `existingNsgId` for a central NSG; raise template changes for flow logs or rules. |
| N10 | **Is outbound traffic forced through a firewall** (a route table on the existing subnet)? If so, which FQDNs are allowed? (A8) | On Flex Consumption *all* outbound traffic goes through the VNet. The app needs at least `graph.microsoft.com`, `login.microsoftonline.com`, certificate revocation endpoints, and the Application Insights endpoints listed in the A8 guidance. | Request the allow-list entries; test outbound connectivity before go-live. |
| N11 | **Naming rules for network resources (A6).** Do the generated names (`vnet-setemailcat-prod-<suffix>`, `nsg-setemailcat-prod-<suffix>-app` / `-pe`) comply? | A naming policy could deny the deployment. | Change the `names` variable in `infra/main.bicep`. |
| N12 | **Confirm private inbound isn't required** (A8). | The template keeps the function's inbound endpoint public, protected by Entra ID, because Power Platform's cloud connectors must reach it. Private inbound needs a different design. | None if confirmed. |

## To verify in a sandbox (not questions for the platform team)

These assumptions are based on Microsoft documentation but haven't been tested in Azure:

- **V1.** Reader on the VNet plus the custom join role on the subnet is enough for Flex Consumption VNet integration and for private endpoints in an existing subnet.
- **V2.** A *deny subnets without an NSG* policy accepts subnets the template declares inline in the VNet, with their NSGs attached at creation.
- **V3.** Private DNS Zone Contributor on a hub zone is enough for the template to register its private endpoints there (DNS zone group).
- **V4.** `privateEndpointNetworkPolicies: NetworkSecurityGroupEnabled` with default NSG rules doesn't block the app's traffic to the storage private endpoints.
- **V5.** End to end: `Setup-GitHubOidc.ps1 -WhatIf`, then a real run, then a deployment with the check step, the smoke test and a first categorised email.

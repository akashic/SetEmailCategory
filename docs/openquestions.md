# Open questions: networking

Networking questions that must be answered before the first production deployment with private networking. The IDs (A6, A8, A10, A11) refer to the decisions in [AZURE-DEPLOYMENT-SETUP.md](AZURE-DEPLOYMENT-SETUP.md#1-environment-decisions); the settings are explained in [RUNBOOK.md, Private networking](RUNBOOK.md#private-networking). Most questions are for William Buck's platform or network team.

Raised 2026-10-22. Record answers in the decisions table, then move them to *Answered* below.

**Known so far:** both subnets the function needs (the app subnet for VNet integration and the private endpoint subnet for storage) already exist in **one shared VNet managed by the platform team, in another resource group**. The template creates no VNet, subnets or NSGs, and `prod.bicepparam` is set up for that.

## Blocking: the deployment can't be configured without these

| # | Question | Why it matters | Once answered |
|---|---|---|---|
| N1 | **The two subnets' resource IDs:** the app subnet and the private endpoint subnet in the shared VNet. (A11) | The deploy job stops while the placeholders remain, and `Setup-GitHubOidc.ps1` needs them to grant access. | Replace the placeholders for `existingAppSubnetId` and `existingPrivateEndpointSubnetId` in `prod.bicepparam`. |
| N2 | **How is `privatelink.blob` and `privatelink.table` DNS managed for the shared VNet?** The hub zones' resource IDs, or whether an Azure Policy registers new private endpoints in them automatically. Is the shared VNet linked to those zones, or does it use the hub's DNS resolver? (A8) | The VNet is shared, so the template can't create its own zones (a VNet can be linked to only one zone of each name). Unless the endpoints are registered in the hub zones, the app can't resolve storage and won't start. | Uncomment `existingBlobPrivateDnsZoneId` and `existingTablePrivateDnsZoneId` with the zone IDs, or leave them unset if a policy registers the endpoints. |
| N3 | **Who will run `Setup-GitHubOidc.ps1` for the network resources?** They need Owner or User Access Administrator on the shared VNet's resource group (and on the DNS zones' resource group if N2 names hub zones), plus permission to create a custom role there. | The deployment identity can't attach the function or the private endpoints to the platform's subnets without these grants. | Agree a session with the network team; send them the `-WhatIf` preview first. |

## Needed to confirm the design

| # | Question | Why it matters | Once answered |
|---|---|---|---|
| N4 | **Is a custom role acceptable?** The script creates *SetEmailCategory Network Join* (read and join subnets and NSGs only). If custom roles aren't allowed, it can grant the built-in Network Contributor instead, which also lets the pipeline change the subnets. | Least privilege versus what the organisation allows. | If not allowed, run the script with `-UseBuiltInNetworkRole`. |
| N5 | **Do the two subnets meet the rules?** Both in Australia East with an NSG attached (A10). The app subnet: delegated to `Microsoft.App/environments` only, /27 or larger (/26 if other Flex apps share it), no private or service endpoints. The private endpoint subnet: not delegated. Is the app subnet already used by other apps? | The deployment fails on a subnet that breaks these rules. A subnet shared with other Flex apps shares their network capacity. | `Test-NetworkPrerequisites.ps1` confirms it once N1 is set; the network team fixes any gaps. |
| N6 | **Is the shared VNet in the same subscription as the function app?** If not, is `Microsoft.Web` registered in that subscription? | VNet integration across subscriptions needs it registered there. | The check script reports it; register the provider if needed. |
| N7 | **Is outbound traffic forced through a firewall** (a route table on the app subnet)? If so, which FQDNs are allowed? (A8) | On Flex Consumption *all* outbound traffic goes through the VNet. The app needs at least `graph.microsoft.com`, `login.microsoftonline.com`, certificate revocation endpoints, and the Application Insights endpoints listed in the A8 guidance. | Request the allow-list entries; test outbound connectivity before go-live. |
| N8 | **Naming rules (A6).** Do the generated names (`func-`, `asp-`, `st`, `appi-`, `log-`, `pe-<storage>-blob` / `-table` followed by `setemailcat-prod-<suffix>`) comply? | A naming policy could deny the deployment. | Change the `names` variable in `infra/main.bicep`. |
| N9 | **Confirm private inbound isn't required** (A8). | The template keeps the function's inbound endpoint public, protected by Entra ID, because Power Platform's cloud connectors must reach it. Private inbound needs a different design. | None if confirmed. |

## To verify in a sandbox (not questions for the platform team)

These assumptions are based on Microsoft documentation but haven't been tested in Azure:

- **V1.** Reader on the VNet plus the custom join role on each subnet is enough for Flex Consumption VNet integration and for private endpoints in an existing subnet.
- **V2.** Private DNS Zone Contributor on a hub zone is enough for the template to register its private endpoints there (DNS zone group).
- **V3.** End to end: `Setup-GitHubOidc.ps1 -WhatIf`, then a real run, then a manual run of the deploy workflow with the network check, the smoke test and a first categorised email.

## Answered

| Question | Answer | Effect |
|---|---|---|
| Which subnet is re-used, and are the resources in one VNet? (2026-10-22) | Both subnets already exist, in the same platform-managed VNet in another resource group. | No VNet, subnets, NSGs or peering from the template, and no IP ranges needed. `createPrivateDnsZones = false` because the VNet is shared. |
| How is deployment triggered? (2026-10-22) | Manually only. | The deploy workflow no longer runs on push; pull requests run the build and tests only. |

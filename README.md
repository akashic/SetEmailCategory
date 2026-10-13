# SetEmailCategory

An Azure Function that sets Outlook categories on messages in a **shared mailbox**. Power Automate / Power Apps call it through a custom connector, because the built-in Office 365 Outlook actions can't set categories on shared mailbox messages.

```
Power Automate flow ──(custom connector, Entra ID OAuth)──► Azure Function (Flex Consumption, .NET 10)
                                                               │  Easy Auth validates token + allowed client app
                                                               ▼
                                                 Microsoft Graph (managed identity)
                                                               │  Exchange RBAC for Applications:
                                                               ▼  Mail.ReadWrite on ONE mailbox only
                                                       Shared mailbox
```

**Security model**
- **Who can call it:** only tokens issued to the custom connector's app registration, and optionally only for members of one security group. App Service Authentication validates them before any code runs.
- **What it can touch:** the function's managed identity has **no** tenant-wide Graph permission. Exchange Online RBAC for Applications grants `Mail.ReadWrite` on that one shared mailbox, and nothing else.
- **No stored secrets in Azure or GitHub:** storage and Application Insights use the managed identity, and deployment uses GitHub OIDC. The only secret is the connector's OAuth client secret, which lives in Power Platform.

## Azure resources

The Bicep deployment creates the following resources in the target resource group:

| Resource | Purpose |
|---|---|
| **Function App** | Runs the HTTP API, validates caller tokens with App Service Authentication (Easy Auth), and uses a system-assigned managed identity for Azure Storage, Application Insights, and Microsoft Graph access. |
| **Flex Consumption plan** | Provides the serverless hosting and scaling configuration for the Function App. |
| **Storage account** | Supplies the Azure Functions host storage and the blob container used for the function deployment package. The app accesses it with its managed identity; shared-key access is disabled. |
| **Application Insights** | Collects application telemetry and provides the failure data used for troubleshooting and alerting. It sends data to the Log Analytics workspace and accepts ingestion using Entra ID authentication. |
| **Log Analytics workspace** | Stores Application Insights telemetry and Function App logs for querying, with configurable retention. |

Optional resources, controlled by deployment parameters:

| Resource | When deployed | Purpose |
|---|---|---|
| **Virtual network and subnets** | `enablePrivateNetworking` is `true` | Provides a delegated subnet for Function App VNet integration and a separate subnet for private endpoints. |
| **Storage private endpoints** | `enablePrivateNetworking` is `true` | Provide private connectivity from the VNet to the storage account's blob, queue, and table services; public network access to storage is disabled. |
| **Private DNS zones, VNet links, and endpoint DNS zone groups** | Private networking is enabled and `createPrivateDnsZones` is `true` | Resolve the storage private endpoints from the VNet. Set `createPrivateDnsZones` to `false` when private DNS is managed centrally. |
| **Monitoring action group and metric alert** | `alertEmailAddresses` is non-empty | Sends email notifications when Application Insights reports failed requests. |

The deployment also configures managed-identity role assignments, Function App authentication and diagnostics, and publishing-credential policies. Entra app registrations and Exchange Online mailbox scoping are set up separately using the scripts described in the [runbook](docs/RUNBOOK.md).

## API

`POST /api/messages/categories`

```json
{
  "messageId": "AAMkAD...",          // "Message Id" from the shared-mailbox trigger
  "internetMessageId": "<...@...>",  // recommended as well: used if the message was moved (angle brackets optional)
  "categories": ["Invoice", "Urgent"],
  "mode": "add"                      // add (default) | replace | remove; names only, numbers are rejected
}
```

Supply `messageId`, `internetMessageId`, or (recommended) both. Outlook message IDs change when a message is moved between folders, which can easily happen between the email arriving and the polling trigger firing. If `messageId` no longer finds the message, the function looks it up by `internetMessageId`.

| Status | Meaning | Does a retry help? |
|---|---|---|
| 200 | `{ messageId, categories, changed }`. `changed: false` means the message already had the categories. | – |
| 400 | Invalid input (including a `mode` that isn't one of the three names), or Graph rejected the request permanently (details in the `application/problem+json` body) | No |
| 401 / 403 | Not authenticated, or the calling app isn't allowed | No |
| 404 | Message not in the shared mailbox (deleted, or moved and no `internetMessageId` supplied) | No |
| 409 | `internetMessageId` matched more than one message | No |
| 413 | Request body over 64 KB (a valid request is at most about 10 KB) | No |
| 500 | App Service Authentication is disabled, so the function refuses all requests (fails closed), or an unexpected error | Only once fixed |
| 502 | The function's identity can't access the mailbox (configuration; up to 2 h after granting access) | Yes, during propagation |
| 503 | Graph throttled or unavailable after retries, or the 90-second deadline was reached | Yes |

Power Automate's default retry policy retries **every** 5xx (408 and 429 too), so 500/502/503 are all retried automatically; 4xx are not.

The call is idempotent, so retries are safe. Each invocation finishes within 90 seconds, inside Power Automate's 120-second limit for synchronous calls. Inside that budget:
- Graph throttling (429) and transient 5xx errors are retried, honouring `Retry-After`.
- Graph requests are limited to 4 at a time per instance (Graph's per-mailbox limit). Each instance takes up to 50 concurrent calls before Flex adds another, so a typical burst stays on one instance. If it does scale out, Graph throttles the excess with 429 and the retries absorb it.
- Concurrent updates to the same message are detected (`If-Match`, and Exchange 409 conflicts) and re-applied.

## Repository layout

| Path | Contents |
|---|---|
| `src/SetEmailCategory` | Function app (.NET 10 isolated worker) |
| `tests/SetEmailCategory.Tests` | Unit tests (`dotnet test`) |
| `infra/` | Bicep: Flex Consumption app, storage, monitoring, optional private networking |
| `infra/env/*.bicepparam` | Per-environment parameters |
| `scripts/` | One-time admin scripts: Entra apps, GitHub OIDC, Exchange scoping, connector build |
| `connector/` | Power Platform custom connector definition (templated) |
| `.github/workflows/deploy.yml` | CI (PRs) and CD (main → environment) |
| `docs/RUNBOOK.md` | **Step-by-step deployment and operations guide** |

## Local development

```bash
dotnet test                                   # unit tests, no Azure needed
cp src/SetEmailCategory/local.settings.json.example src/SetEmailCategory/local.settings.json
cd src/SetEmailCategory && func start
```

To call Graph locally, fill `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` with values for a *dev* app registration. That app must be scoped by Exchange RBAC to a **test** mailbox, never the production one. Without credentials, everything except the Graph call still works.

## Deploying

Follow [docs/RUNBOOK.md](docs/RUNBOOK.md).

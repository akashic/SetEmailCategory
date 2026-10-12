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

## API

`POST /api/messages/categories`

```json
{
  "messageId": "AAMkAD...",          // from the shared-mailbox trigger; or use internetMessageId
  "internetMessageId": "<...@...>",  // optional; finds the message even after it was moved (angle brackets optional)
  "categories": ["Invoice", "Urgent"],
  "mode": "add"                      // add (default) | replace | remove
}
```

| Status | Meaning | Retry? |
|---|---|---|
| 200 | `{ messageId, categories, changed }`. `changed: false` means the message already had the categories. | – |
| 400 | Invalid input (details in the `application/problem+json` body) | No |
| 401 / 403 | Not authenticated, or the calling app isn't allowed | No |
| 404 | Message not in the shared mailbox (deleted or moved) | No |
| 409 | `internetMessageId` matched more than one message | No |
| 500 | App Service Authentication is disabled, so the function refuses all requests (fails closed) | No |
| 502 | The function's identity can't access the mailbox (a configuration problem) | No |
| 503 | Microsoft Graph unavailable after retries | Yes |

The call is idempotent, so it's safe to retry. Concurrent updates are protected with ETags (`If-Match`). Throttling (429) and transient 5xx errors from Graph are retried, honouring `Retry-After`.

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

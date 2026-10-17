# SetEmailCategory: Deployment & Operations Runbook

This runbook takes a new environment from nothing to a working Power Automate flow, then covers day-2 operations. Phases 1–3 and 5–6 are one-time admin tasks per environment. After that, every merge to `main` deploys automatically.

| Phase | What | Who (role needed) | Time |
|---|---|---|---|
| 0 | Prerequisites | Azure subscription Owner | 15 min |
| 1 | Entra ID app registrations | Entra **Application Administrator** | 10 min |
| 2 | Environment parameters | Developer | 5 min |
| 3 | GitHub OIDC deployment identity | Subscription/RG **Owner**, GitHub repo admin | 10 min |
| 4 | First deployment | Pipeline (automatic) | 10 min |
| 5 | Scope mailbox access in Exchange | **Exchange Administrator** / Organization Management | 10 min + up to 2 h propagation |
| 6 | Custom connector & DLP | Power Platform **Environment Maker** + **Power Platform Admin** (DLP) | 20 min |
| 7 | Build the flow | Flow author | 15 min |
| 8 | End-to-end verification | Flow author | 10 min |

For what each account, GitHub setting and config file does, and how to set it without the scripts, see [AZURE-DEPLOYMENT-SETUP.md](AZURE-DEPLOYMENT-SETUP.md).

All scripts are PowerShell 7 and run unchanged in **Azure Cloud Shell** (PowerShell mode), which already has `az`, `pwsh` and `Install-Module` access. Every script is safe to re-run.

---

## Phase 0: Prerequisites

1. **Choose a region that supports Flex Consumption:**
   ```bash
   az functionapp list-flexconsumption-locations --query "[].name" -o tsv
   ```
2. **Register resource providers** (once per subscription):
   ```bash
   for p in Microsoft.Web Microsoft.Storage Microsoft.Insights Microsoft.OperationalInsights Microsoft.Network Microsoft.App; do
     az provider register --namespace $p
   done
   ```
   `Microsoft.App` is needed only for private networking (Flex VNet integration uses subnet delegation to `Microsoft.App/environments`).
3. **Confirm the shared mailbox exists** and note its primary SMTP address.
4. **Create a caller group.** Create an Entra security group containing the people or service account who own the flows, for example `SG-SetEmailCategory-Users`. Only its members will be able to create a connection to the connector. The function changes the mailbox with its own permission, so members can change categories on any message in the shared mailbox: limit the group to people who already have access to that mailbox. `Setup-EntraApps.ps1` refuses to run without it unless you pass `-AllowAnyTenantUser`.
5. **Check Azure Policy.** This template already disables storage shared keys, blob public access, FTP/basic auth and App Insights local auth, and enforces TLS 1.2. If your landing zone requires extra tags or diagnostic settings, add them to `tags` in the parameter file.

## Phase 1: Entra ID app registrations

```powershell
./scripts/Setup-EntraApps.ps1 -Environment prod -CallerGroupObjectId <group-object-id>
```

This creates two app registrations:
- **SetEmailCategory API (prod).** This is the resource the function validates tokens for. It exposes the `user_impersonation` scope and issues v2.0 tokens. The API requires assignment to the caller group, so only group members can get a token.
- **SetEmailCategory Connector (prod).** This is the OAuth client used by the custom connector. It gets admin consent to the API scope and a client secret.

**The client secret is printed once.** Store it in your password vault immediately, because Phase 6 needs it. Record its expiry date in your secret-rotation calendar.

Output: `entra-output.prod.json` (identifiers only, no secrets; git-ignored).

> Neither app registration gets any Microsoft Graph permission. Mailbox access belongs to the function's managed identity (Phase 5).

## Phase 2: Environment parameters

Edit `infra/env/prod.bicepparam`, using values from `entra-output.prod.json`:

| Parameter | Value |
|---|---|
| `sharedMailboxAddress` | Shared mailbox primary SMTP address |
| `apiAppClientId` | `apiAppClientId` |
| `allowedClientApplicationIds` | `[ connectorClientId ]` |
| `alertEmailAddresses` | Ops distribution list |
| `tags` | Your organisation's mandatory tags |
| `enablePrivateNetworking` | `false` unless policy requires private storage (see [Private networking](#private-networking)) |
| `alwaysReadyInstances` | `0` scales to zero, so the first call after idle has a cold start of a few seconds. `1` removes cold starts at a small fixed cost. |
| Scale (`maximumInstanceCount`, `httpPerInstanceConcurrency`, `graphConcurrencyPerInstance`, `requestDeadlineSeconds`) | Leave the defaults (40 / 50 / 4 / 90). Microsoft advises at least 40 instances for HTTP apps: below that, bursts of email are rejected by the platform before reaching the code. Graph allows 4 concurrent requests per app per mailbox. The function enforces that **per instance**, so N instances can send up to 4N. A per-instance HTTP concurrency of 50 means Flex only adds a second instance when more than 50 calls are in flight at once. Below that, every call shares one instance and one 4-slot gate. Above it, Graph throttles the excess with 429 and `Retry-After`, which the function honours, so the result is slower calls, not failures. |

These values are identifiers, not secrets, so commit the file.

## Phase 3: GitHub OIDC deployment identity

```powershell
./scripts/Setup-GitHubOidc.ps1 -SubscriptionId <sub-id> -ResourceGroup rg-setemailcat-prod -Location <region> `
    -GitHubRepository WilliamBuckAustralia/SetEmailCategory -GitHubEnvironment prod -SetGitHubVariables
```

This creates the resource group (if needed) and a user-assigned managed identity. GitHub can only use that identity from the `prod` environment of this repo. The script grants it:
- **Contributor** on the resource group only.
- **Role Based Access Control Administrator** on the resource group, with a condition that it can only assign the three roles the function needs (Storage Blob Data Owner, Storage Table Data Contributor and Monitoring Metrics Publisher), and only to service principals.

It writes `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `AZURE_RESOURCE_GROUP` as variables on the GitHub environment. Without `-SetGitHubVariables`, it prints them for you to add by hand.

Then, in GitHub, open **Settings → Environments → prod** and set:
- **Required reviewers:** recommended for production.
- **Deployment branches:** `main` only.

## Phase 4: First deployment

Run the **build-and-deploy** workflow (Actions tab → *Run workflow*), or merge to `main`. The workflow:
1. Runs the unit tests, publishes a ReadyToRun build and lints the Bicep.
2. Runs `what-if`, then deploys the Bicep and uploads the code package.
3. Runs a smoke test: waits until `/api/health` reports the new commit SHA, and checks that an unauthenticated call returns **401**.

The run summary shows the **function app name**, the **endpoint URL** and the **managed identity object ID**, which you need next.

<details><summary>Manual fallback (no pipeline)</summary>

```bash
az deployment group create -g rg-setemailcat-prod --parameters infra/env/prod.bicepparam --query properties.outputs
dotnet publish src/SetEmailCategory -c Release -r linux-x64 --self-contained false -p:PublishReadyToRun=true -o publish
(cd publish && zip -qr ../app.zip .)
az functionapp deployment source config-zip -g rg-setemailcat-prod -n <functionAppName> --src app.zip
```
</details>

## Phase 5: Scope mailbox access in Exchange Online

```powershell
./scripts/Grant-MailboxAccess.ps1 -ResourceGroup rg-setemailcat-prod -FunctionAppName <functionAppName> `
    -SharedMailbox <shared-mailbox@contoso.com> -NegativeTestMailbox <any-other-mailbox@contoso.com>
```

The script:
1. **Refuses to continue** if the managed identity has any Microsoft Graph or Office 365 Exchange Online application permission in Entra ID. Exchange RBAC grants are *added to* Entra grants, so a tenant-wide grant such as Graph `Mail.ReadWrite` or Exchange `full_access_as_app` would make the mailbox scope meaningless.
2. Registers the managed identity in Exchange (`New-ServicePrincipal`).
3. Creates a management scope containing only the shared mailbox, and assigns the **Application Mail.ReadWrite** role within that scope.
4. Runs `Test-ServicePrincipalAuthorization` to prove the shared mailbox is **in scope** and the negative-test mailbox is **out of scope**.

**Permission changes take 30 minutes to 2 hours to reach the app.** Until then, calls return **502 "Mailbox access denied"**.

> If the shared mailbox's primary SMTP address ever changes, re-run this script. The management scope filters on that address.

## Phase 6: Custom connector & DLP

1. **Build the connector files:**
   ```powershell
   ./scripts/Build-ConnectorDefinition.ps1 -EntraOutput ./entra-output.prod.json `
       -FunctionHostName <functionAppHostName> -Publisher "<Your team>"
   ```
2. **Create the connector** with the [Power Platform CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction):
   ```bash
   pac auth create --environment <environment-url>
   pac connector create --environment <environment-url> \
     --api-definition-file connector/dist/prod/apiDefinition.swagger.json \
     --api-properties-file connector/dist/prod/apiProperties.json
   # Optional for ALM: add --solution-unique-name <solution> to create it inside a solution.
   ```
   Or import the swagger file in the maker portal (**Custom connectors → New → Import an OpenAPI file**) and set Security as below.
3. **Add the client secret.** In the maker portal, open the connector → **Security** tab → paste the client secret from Phase 1 → **Update connector**. Check that the identity provider is *Azure Active Directory*, the client ID is `connectorClientId` and the resource URL is `apiIdentifierUri`.
4. **Register the connector's redirect URI.** Copy the **Redirect URL** shown on the Security tab (it's unique to the connector), then run:
   ```powershell
   ./scripts/Setup-EntraApps.ps1 -Environment prod -ConnectorRedirectUri '<redirect-url>'
   ```
5. **Configure DLP (Power Platform admin).** In the environment's DLP policy, put the custom connector in the **same data group** (usually *Business*) as **Office 365 Outlook**, or the flow will be blocked. If your tenant uses a custom-connector URL pattern allow-list, add `https://<functionAppHostName>/*`.
6. **Choose the connection identity carefully.** The connection holds a *delegated* sign-in. It breaks, and every flow run fails with 401 until someone signs in again, if that account's password is reset, the account is disabled (e.g. the person leaves), or a Conditional Access policy requires re-authentication.
   - Use a **dedicated service account** (licensed for Power Automate premium, member of the caller group), not a personal account, and make it the flow owner.
   - With your identity team, make sure Conditional Access **sign-in frequency** and **compliant-device** policies don't apply to this account's access to the *SetEmailCategory API* app. Otherwise the connection expires on that schedule.
   - Entra refresh tokens also expire after 90 days without use, so a connection that sits idle that long will need re-authenticating. For a mailbox that receives mail regularly, this won't happen.
7. **Test the connection.** Open the **Test** tab → **New connection** → sign in as the service account. Then call the operation with a real message ID (see Phase 8).

## Phase 7: Build the flow

1. **Trigger:** Office 365 Outlook → *When a new email arrives in a shared mailbox (V2)*, using the shared mailbox address.
2. **Action:** *Shared Mailbox Categories* → *Set categories on a shared mailbox message*, with:
   - **Message Id:** `Message Id` from the trigger.
   - **Internet Message Id:** `Internet Message Id` from the trigger. **Always pass both.** The trigger polls, so the call can arrive minutes after the email does; if someone (or an inbox rule) moves the message in the meantime its Message Id changes, and the function then finds it by Internet Message Id instead of failing with 404.
   - **Categories:** one array item per category (e.g. `Invoice`). Don't comma-separate them into one item.
   - **Mode:** `add` (keeps existing categories), `replace` or `remove`.
   - **Correlation ID** (advanced): `workflow()?['run']?['name']`. This lets you find the flow run in the function logs.
3. **Retry policy.** Power Automate's *default* policy retries every 5xx, 408 and 429 response: up to 12 times over about an hour on the Medium/High performance profiles, but only twice (5–10 minutes apart) on the Low profile. The function is idempotent, so retries are always safe. To make behaviour explicit and the same on every licence, set the action's *Settings → Retry policy* to **Exponential interval**, count **6**, interval **PT20S**, maximum interval **PT10M**. That covers transient Graph throttling (503) and a short Exchange permission delay (502). 4xx responses are never retried, because they won't succeed on retry.
4. **Handle failures visibly.** Add a parallel branch with *Configure run after → has failed / has timed out* that notifies the mailbox owners (e.g. a Teams message with the run link). Otherwise a failed categorisation is only visible in the run history.
5. **Burst behaviour.** If many emails arrive together, runs execute in parallel. Up to 50 in-flight calls share one function instance, which queues them for Graph 4 at a time and finishes each within 90 seconds. Calls that hit the deadline return 503, and the retry policy (step 3) retries them. **Leave the trigger's concurrency control off.** Microsoft documents two catches:
   - Turning it on can't be undone without deleting and re-adding the trigger.
   - Once the waiting-run queue (10 + degree of parallelism) is full, further trigger events may never become runs, so emails would go uncategorised.
   
   Consider it only if run history shows persistent 503s during bursts *and* the *Scale-out and Graph retries* query (Operations → Monitoring) confirms throttling. Even then, test it on a copy of the flow first.
6. **Categories and colours:** a category that doesn't exist in the mailbox's master category list is still applied, but shows without a colour. To get colours, create the categories once in Outlook while signed in to the shared mailbox.

## Phase 8: End-to-end verification

- [ ] Send a test email to the shared mailbox. The flow runs, the action returns 200, and Outlook shows the category. If it returns **500 "Service misconfigured"** instead, see the troubleshooting row for it: this first authenticated call is what proves the platform reports Easy Auth as enabled.
- [ ] Re-run the same flow run. With mode `add` or `remove` it returns 200 with `changed: false`, which shows the call is idempotent. (`replace` always reports `changed: true`, because it writes without reading the message first.)
- [ ] Call the connector with a made-up message ID. It returns 404.
- [ ] In Application Insights → **Transaction search**, find the request by its correlation ID.
- [ ] `curl -X POST https://<host>/api/messages/categories` with no token returns 401.
- [ ] (Optional) A user **outside** the caller group can't create a connection.

---

## Operations

### Monitoring

Application Insights (`appi-setemailcat-<env>-*`) → **Logs**:

```kusto
// Request volume and failures
requests
| where timestamp > ago(7d) and name == "SetCategory"
| summarize total = count(), failed = countif(success == false) by bin(timestamp, 1d), resultCode

// Graph errors with request IDs (give these to Microsoft support)
traces
| where timestamp > ago(7d) and message startswith "Graph returned"
| project timestamp, message, correlationId = tostring(customDimensions.CorrelationId), caller = tostring(customDimensions.CallerName)

// Scale-out and Graph retries: more than one instance during a burst means the per-instance Graph gate
// is multiplied; OnRetry events with Result 429 show Graph throttling it back
requests
| where timestamp > ago(7d) and name == "SetCategory"
| summarize calls = count(), instances = dcount(cloud_RoleInstance) by bin(timestamp, 5m)
| join kind=leftouter (
    traces
    | where timestamp > ago(7d) and message has "OnRetry"
    | summarize graphRetries = count(), throttled = countif(message has "429") by bin(timestamp, 5m)
  ) on timestamp
| where instances > 1 or graphRetries > 0
| project timestamp, calls, instances, graphRetries, throttled
```

If `alertEmailAddresses` is set, three log search alerts email the list:

| Alert | Fires when | Severity | Usually means |
|---|---|---|---|
| `server-errors` | Any 500 or 502 in 15 minutes | 2 | Misconfiguration (Easy Auth disabled, mailbox access missing or still propagating) or a bug. See the troubleshooting table. |
| `graph-throttling` | More than `throttlingAlertThreshold` (default 10) 503s in 15 minutes | 2 | Graph throttling or an outage outlasting retries. A few 503s during a burst are normal and retried by the flow. |
| `caller-errors` | Any 400, 409 or 413 in an hour | 3 | A flow is sending invalid input. 404 is excluded: messages deleted before the flow runs make it routine. |

401 and 403 never reach the function (App Service Authentication answers them first), so no alert covers them.

### Secret rotation (connector client secret)

The connector's client secret is the only secret in the solution. Before it expires:
```powershell
./scripts/Setup-EntraApps.ps1 -Environment prod -RotateSecret
```
Paste the new secret on the connector's **Security** tab → **Update connector**. Existing connections continue to work. After confirming flows run, delete the old secret under **App registrations → SetEmailCategory Connector → Certificates & secrets**.

### Rollback

Flex Consumption has no deployment slots, so you roll back by redeploying a previous commit: **Actions → build-and-deploy → Run workflow** and pick the earlier tag or commit as the ref. Tag each production release (`git tag v1.2.0 && git push --tags`) so known-good points are easy to find.

### Adding dev/test environments

1. Use a **separate test shared mailbox**. Never point non-production at the production mailbox.
2. Copy `infra/env/prod.bicepparam` to `infra/env/dev.bicepparam` and set `environmentName = 'dev'`.
3. Run Phases 1, 3, 5 and 6 with `-Environment dev` / `-GitHubEnvironment dev`.
4. Add `dev` to the workflow's `environment` choice list.

### Private networking

Set `enablePrivateNetworking = true` to:
- make storage reachable only through private endpoints (blob and table), and
- integrate the function with a new VNet for outbound traffic.

**Inbound** stays public, protected by Entra ID, because Power Platform's cloud connectors must reach it.

- **If your landing zone manages private DNS centrally** (hub `privatelink.*` zones plus Azure Policy), also set `createPrivateDnsZones = false`. Policy then links the private endpoints to the hub zones.
- **If the VNet must peer to a hub**, adjust `vnetAddressPrefix`, `appSubnetPrefix` and `privateEndpointSubnetPrefix` to a non-overlapping range from your IPAM, and peer it after deployment.
- **Making inbound private as well** isn't covered by this template. It needs a function-app private endpoint, [Power Platform virtual network support](https://learn.microsoft.com/power-platform/admin/vnet-support-overview) for the environment, and self-hosted GitHub runners inside the network.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 from the connector | Token audience or issuer mismatch, or Easy Auth misconfigured | Check `apiAppClientId` in the parameter file matches the API app. Check the connector resource URL is `api://<apiAppClientId>`. |
| Flow fails with 401 / `ConnectionAuthorizationFailed` after working for a while | The connection's sign-in expired: password reset, account disabled, Conditional Access re-authentication, or 90 days unused | Re-authenticate the connection (Power Automate → *Data → Connections* → fix). Prevent recurrence with a service account and Conditional Access exclusions (Phase 6, step 6). |
| 403 from the connector | Token was issued to a client not in `allowedClientApplicationIds` | Add the connector's client ID to the parameter file and redeploy. |
| `AADSTS50105` when creating a connection | User isn't in the caller group | Add the user to the group from Phase 0. |
| `AADSTS50011` redirect URI mismatch | The connector's unique redirect URI isn't registered | Phase 6, step 4. |
| 502 "Mailbox access denied" | Exchange RBAC missing, still propagating, or the mailbox address changed | Wait up to 2 h after Phase 5. Re-run `Grant-MailboxAccess.ps1`; it verifies the scope. |
| 404 "Message not found" | Message deleted or moved after the trigger fired | Pass `internetMessageId` instead. |
| 500 "Service misconfigured" | App Service Authentication is off, so the function refuses every request rather than run unprotected | Redeploy the Bicep to restore `authsettingsV2`. If Authentication **is** on in the portal, the platform may not be setting `WEBSITE_AUTH_ENABLED` on Flex Consumption; check the app's environment variables, and only then set `Security__RequireEasyAuthEnabled = false` in `functionApp.bicep`. |
| 400 "contains a comma" | Categories passed as `"A, B"` | Use one array item per category. |
| 503 "Upstream failure" or "Timed out" | Graph throttling or outage persisted through retries, or the 90-second deadline was reached | The flow retry policy handles it. If it's persistent, check [Microsoft 365 service health](https://admin.microsoft.com/servicehealth). |
| 504 `ResponseTimeout` or 429 in flow run history | A large burst of emails exceeded capacity | Check `maximumInstanceCount` hasn't been lowered below 40 and `httpPerInstanceConcurrency` hasn't been lowered from 50. Run the *Scale-out and Graph retries* query. Trigger concurrency control is a last resort (Phase 7, step 5). |
| 413 "Request body too large" | Body over 64 KB: almost always a wrong expression mapped to *Categories* (e.g. the whole email body) | Fix the flow's mapping. A valid request is at most about 10 KB. |
| 400 "'mode' must be one of" or "Invalid JSON" mentioning `mode` | A number or custom value was entered for *Mode* | Use `add`, `replace` or `remove`. Numbers aren't accepted. |
| 400 "Rejected by Microsoft Graph" | Graph refused the request for a non-transient reason (the body includes Graph's error code) | Look up the code. Retrying won't help. |
| Smoke test "App did not detect it is running in Azure" | None of the expected host environment variables are set on this plan | Check the app's environment variables (Kudu/SSH or `az functionapp config appsettings list`) and add the marker that is present to `PlatformInfo.AzureHostMarkers`. |
| Smoke test "App is refusing requests" | `WEBSITE_AUTH_ENABLED` is not `True` | See the "500 Service misconfigured" row. |
| Smoke test "new version did not come up" | App failed to start, often from a missing `SharedMailbox__Address` | Application Insights → Failures / traces for startup exceptions. |
| Deployment fails assigning roles | Pipeline identity lacks the constrained RBAC Administrator role | Re-run `Setup-GitHubOidc.ps1`. |

### One-off cleanup for deployments made before the queue role and metric alert were removed

The pipeline deploys in incremental mode, so resources the template no longer defines stay in Azure. Environments first deployed before this change still have a queue role assignment, a `failed-requests` metric alert and, with private networking, a queue private endpoint and DNS zone. They're harmless but unused (the old alert also duplicates the new ones). Remove them once, after the new template has deployed, as someone with Owner or User Access Administrator on the resource group:

```bash
RG=rg-setemailcat-prod
FUNC=<functionAppName>
ST=$(az resource list -g $RG --resource-type Microsoft.Storage/storageAccounts --query "[0].name" -o tsv)
PRINCIPAL=$(az functionapp identity show -g $RG -n $FUNC --query principalId -o tsv)

az role assignment delete --assignee "$PRINCIPAL" --role "Storage Queue Data Contributor" \
  --scope "$(az storage account show -g $RG -n $ST --query id -o tsv)"

# Old metric alert (named alert-<workload>-<env>-<suffix>-failed-requests)
az monitor metrics alert list -g $RG --query "[?ends_with(name, '-failed-requests')].name" -o tsv \
  | xargs -r -I{} az monitor metrics alert delete -g $RG -n {}

# Only if enablePrivateNetworking is true. Deleting the endpoint removes its DNS zone group; a zone with VNet links
# can't be deleted, so remove the links first. Skip the zone steps if a hub manages private DNS centrally.
ZONE=privatelink.queue.core.windows.net
az network private-endpoint delete -g $RG -n "pe-$ST-queue"
az network private-dns link vnet list -g $RG -z $ZONE --query "[].name" -o tsv \
  | xargs -r -I{} az network private-dns link vnet delete -g $RG -z $ZONE -n {} --yes
az network private-dns zone delete -g $RG -n $ZONE --yes
```

`Setup-GitHubOidc.ps1` doesn't update an existing deployment identity's role condition, so in these environments it can still assign the queue role. That's harmless (it's still limited to the listed roles); re-create the RBAC Administrator assignment if you want the tighter list.

### Decommissioning

1. Delete the flows and the custom connector, and remove the connector from the DLP policy.
2. In Exchange Online:
   ```powershell
   Remove-ManagementRoleAssignment "SetEmailCategory - <functionAppName> - Mail.ReadWrite"
   Remove-ManagementScope "SetEmailCategory - <address>"
   ```
   The Exchange service-principal pointer is removed automatically when the managed identity is deleted.
3. Delete the resource group, which removes the function app, its managed identity, storage, monitoring and the deployment identity.
4. Delete both app registrations (*SetEmailCategory API/Connector (env)*).
5. Delete the GitHub environment.

## Security summary (for review boards)

| Control | Implementation |
|---|---|
| Caller authentication | Entra ID OAuth (delegated) through the custom connector. App Service Authentication validates issuer, audience and calling app before code runs. |
| Caller authorisation | `allowedApplications` = connector app only. Assignment-required caller group on the API app (opting out needs `-AllowAnyTenantUser`). The function uses its own mailbox permission, so the group should match who already has access to the shared mailbox. |
| Defence in depth | The function also rejects requests without an Easy Auth principal header, which the platform strips from client requests. It fails closed: if App Service Authentication is ever disabled, it refuses every request. |
| Mailbox access | System-assigned managed identity. Exchange RBAC for Applications grants `Mail.ReadWrite` on **one** mailbox, and **no** Entra application permission on Microsoft Graph or Office 365 Exchange Online (the script enforces this). |
| Secrets | None in Azure or GitHub. Storage and App Insights use Entra ID. Deployment uses OIDC federation. One OAuth client secret is held by Power Platform and rotated per the procedure above. |
| Deployment privilege | RG-scoped Contributor, plus RBAC Administrator constrained by ABAC to three roles for service principals. |
| Platform hardening | HTTPS only, TLS 1.2+, FTP/SCM basic auth disabled, storage shared keys and public blob access disabled, App Insights local auth disabled. Optional private endpoints. |
| Audit | Caller identity, correlation ID and Graph request IDs are logged to Application Insights. Function logs go to Log Analytics (90-day default retention). Message content is never logged. |

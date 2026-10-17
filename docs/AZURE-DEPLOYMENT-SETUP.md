# Azure deployment setup

Everything that must be configured before `.github/workflows/deploy.yml` can deploy SetEmailCategory and the function can be used: identities, GitHub settings and environment-specific files. [RUNBOOK.md](RUNBOOK.md) is the step-by-step procedure (phases 0–8); this guide is the reference behind it.

## Contents

1. [Environment decisions](#1-environment-decisions)
2. [How a deployment authenticates](#2-how-a-deployment-authenticates)
3. [Identities and permissions](#3-identities-and-permissions)
4. [Azure prerequisites](#4-azure-prerequisites)
5. [GitHub configuration](#5-github-configuration)
6. [Configuration files](#6-configuration-files)
7. [Setup order](#7-setup-order)
8. [Adding a dev or test environment](#8-adding-a-dev-or-test-environment)
9. [Verification commands](#9-verification-commands)
10. [Status (2026-10-18)](#10-status-2026-10-18)

---

## 1. Environment decisions

Answers from William Buck Australia's environment owners (2026-10-18). **Open** items block the first deployment; guidance for them follows the table.

| # | Question | Answer | Action |
|---|---|---|---|
| T1 | Azure, Exchange Online and Power Platform in one Entra tenant? | Yes. GitHub Enterprise accounts sign in through a different tenant. | None. Azure trusts GitHub's OIDC token, not the tenant GitHub users sign in with. |
| A1 | Cloud? | Commercial (worldwide) | None |
| A2 | Region, Flex Consumption availability, quota? | Australia East | `location = 'australiaeast'` is set in `prod.bicepparam`. Ask for the RG in Australia East too. **Confirm** Flex availability (`az functionapp list-flexconsumption-locations -o table`) and quota for 40 × 512 MB. |
| A3 | Who creates the resource group? | Platform team: `<resource-group-name>` | Pass it to `Setup-GitHubOidc.ps1 -ResourceGroup`; the script reuses it. Whoever runs the script needs Owner or User Access Administrator on the RG. |
| A4 | May we create the GitHub deployment identity? | Yes, with `Setup-GitHubOidc.ps1` | Run with `-Location australiaeast` once G1 is answered. |
| A5 | Contributor plus ABAC-constrained RBAC Administrator on the RG? | Yes | None |
| A6 | Azure Policy constraints? | Tags/locations, private storage, naming rules | Set `tags`. Private storage: `enablePrivateNetworking = true` (set; depends on A8). **Open: naming rules.** Names are generated as `<type>-<workload>-<env>-<suffix>` with only `workload` configurable, so get `<naming-convention>` and change the `names` variable in `infra/main.bicep` before deploying. |
| A7 | Central Log Analytics or action groups? | No, self-contained | None |
| A8 | Hub peering and central DNS, IP range, firewall egress, private inbound? | **Open** | See [A8 guidance](#a8-networking). |
| A9 | Always-on instance to avoid cold starts? | No, scale to zero | `alwaysReadyInstances = 0` (default) |
| I1 | May an Application Administrator run `Setup-EntraApps.ps1`? | Yes | None |
| I2 | Client secrets allowed, and for how long? | Yes, 12+ months | None; diarise rotation. |
| I3 | Caller security group with *Assignment required*? | Yes: `<caller-group-name>` | Pass its object ID as `-CallerGroupObjectId`. Limit it to people who already have access to the shared mailbox. |
| I4 | Dedicated service account, excluded from sign-in-frequency and compliant-device Conditional Access? | Yes: `<service-account-upn>` | None ([section 3.6](#36-g-power-automate-service-account)) |
| E1 | Shared mailbox and negative-test mailbox? | `<shared-mailbox-address>`, `<negative-test-mailbox-address>` | `sharedMailboxAddress` and `Grant-MailboxAccess.ps1` |
| E2 | Can an Exchange administrator run `Grant-MailboxAccess.ps1`? | **Open** | Also confirm the function's identity will have no Graph or Exchange Online application permissions (the script refuses otherwise). |
| E3 | Test mailbox for dev/test? | Yes: `<test-mailbox-address>` | [Section 8](#8-adding-a-dev-or-test-environment) |
| P1 | Power Platform environment and Environment Maker? | `<power-platform-environment>`, `<environment-maker>` | Runbook Phase 6 |
| P2 | DLP allows custom connectors? URL allow-list? | Allowed, no allow-list | None |
| P3 | Premium licence? Connector in a solution? | Premium; solution `<solution-unique-name>` | Add `--solution-unique-name <solution-unique-name>` to `pac connector create`. |
| G1 | Does the organisation restrict Actions, or customise the OIDC subject or issuer? | **Open** | See [G1 guidance](#g1-github-organisation-policies). Answer before running `Setup-GitHubOidc.ps1`. |
| G2 | Who approves production deployments? | `<prod-approvers>` | Required reviewers on `prod` ([section 5.2](#52-environment-protection-rules)) |

Replace each `<placeholder>` here, in the parameter file and in script arguments as values are confirmed.

### A8: networking

Private storage (A6) puts storage behind private endpoints and the app's outbound traffic through a new VNet. `prod.bicepparam` holds placeholders for the three VNet ranges, so the deploy job stops until they're set from IPAM; `createPrivateDnsZones` stays at its default (`true`, the template creates its own `privatelink` zones) until A8 is answered.

- **Hub with central private DNS:** `createPrivateDnsZones = false`; Azure Policy links the endpoints to the hub zones.
- **Peering:** set `vnetAddressPrefix`, `appSubnetPrefix` and `privateEndpointSubnetPrefix` from IPAM, then peer after deployment.
- **Firewall egress:** on Flex Consumption *all* outbound traffic uses the VNet. Allow at least `graph.microsoft.com`, `login.microsoftonline.com`, certificate-revocation endpoints, and the Application Insights endpoints in the connection string (`<region>.in.applicationinsights.azure.com`, `<region>.livediagnostics.monitor.azure.com`). Also allow the usage-data endpoints (`westeurope-5.in.applicationinsights.azure.com`, `westus-0.in.applicationinsights.azure.com`) or set `APPLICATIONINSIGHTS_STATSBEAT_DISABLED=true`. Test outbound connectivity before go-live.
- **Private inbound:** not supported by this template. It needs a private endpoint on the app, self-hosted GitHub runners, and Power Platform VNet support (Managed Environment, E5/A5/G5-class licences, delegated subnets in both paired regions).

### G1: GitHub organisation policies

- **Allowed-actions list:** allow `actions/checkout`, `actions/setup-dotnet`, `actions/upload-artifact`, `actions/download-artifact` and `azure/login`.
- **Custom OIDC subject template or enterprise-specific issuer:** `Setup-GitHubOidc.ps1` stops; create the federated credential by hand to match the token's `sub` and issuer.

### Sources

Checked on Microsoft Learn, 2026-10-16. Re-check before relying on them: [Flex Consumption networking](https://learn.microsoft.com/azure/azure-functions/functions-networking-options?pivots=flex-consumption-plan), [Azure Monitor network access](https://learn.microsoft.com/azure/azure-monitor/fundamentals/azure-monitor-network-access), [Application Insights FAQ](https://learn.microsoft.com/azure/azure-monitor/app/application-insights-faq), [App Service Environment networking](https://learn.microsoft.com/azure/app-service/environment/networking), [Power Platform VNet support](https://learn.microsoft.com/power-platform/admin/vnet-support-overview), [Exchange RBAC for Applications](https://learn.microsoft.com/exchange/permissions-exo/application-rbac), [Azure Login with OIDC](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect).

---

## 2. How a deployment authenticates

```
GitHub Actions (deploy job, environment: prod)
   │  OIDC token: sub = repo:WilliamBuckAustralia@<owner-id>/SetEmailCategory@<repo-id>:environment:prod
   ▼
Microsoft Entra ID → federated credential on managed identity id-github-setemailcat-prod
   ▼
azure/login (client, tenant and subscription IDs from GitHub environment variables)
   │  az deployment group create: Contributor creates resources; constrained RBAC Administrator assigns 3 roles
   │  az functionapp deployment source config-zip: app.zip
   ▼
Function app (system-assigned identity) → storage and App Insights via Azure RBAC,
                                          shared mailbox via Exchange RBAC for Applications
```

**No secrets in GitHub.** Don't create an `AZURE_CREDENTIALS` secret or a deployment client secret.

---

## 3. Identities and permissions

| # | Identity | Created by | Purpose | Secret |
|---|---|---|---|---|
| A | Admins | Existing | Run the one-time setup | – |
| B | `id-github-setemailcat-<env>` (user-assigned managed identity) | `Setup-GitHubOidc.ps1` | GitHub Actions deploys | No (OIDC) |
| C | Function app system-assigned identity | Bicep | Storage, App Insights, Graph | No |
| D | *SetEmailCategory API (<env>)* app registration | `Setup-EntraApps.ps1` | Audience Easy Auth validates | No |
| E | *SetEmailCategory Connector (<env>)* app registration | `Setup-EntraApps.ps1` | Custom connector's OAuth client | **One client secret, held only in Power Platform** |
| F | Caller security group | Admin | Who can get a token for D | – |
| G | Power Automate service account | Admin | Owns the flow and connection | Vaulted password |
| H | Dev app registration (optional) | Developer | Local Graph calls to a **test** mailbox | In `local.settings.json` only |

### 3.1 A: Admin roles

| Task | Minimum role |
|---|---|
| `Setup-GitHubOidc.ps1` (identity B and its role assignments) | Owner, or User Access Administrator plus Contributor, on the RG |
| `-SetGitHubVariables`, environment and branch protection | GitHub repo **Admin** |
| `Setup-EntraApps.ps1` (D, E, consent, group assignment) | Entra **Application Administrator** or **Cloud Application Administrator** |
| Create F and G | **Groups Administrator** / **User Administrator** |
| `Grant-MailboxAccess.ps1` | Exchange **Organization Management** (or Entra **Exchange Administrator**), plus read access to the function app |
| `pac connector create` | Power Platform **Environment Maker** |
| DLP policy | **Power Platform Administrator** |

### 3.2 B: GitHub deployment identity

| Property | Value |
|---|---|
| Name, location | `id-github-setemailcat-<env>` in the deployment RG, `-Location` region |
| Federated credential | Issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, subject `<sub_claim_prefix>:environment:<env>` |
| Roles on the RG | **Contributor**; **Role Based Access Control Administrator** with an ABAC condition allowing assignments only of Storage Blob Data Owner (`b7e6dc6d-f1e8-4753-8033-0f276bb0955b`), Storage Table Data Contributor (`0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`) and Monitoring Metrics Publisher (`3913510d-42f4-4e42-8a64-420c390055eb`), to service principals only |

The subject is environment-scoped, so only a job declaring `environment: <env>` can sign in; that's what makes environment protection rules effective. If you add a role assignment to the Bicep, add its ID to `$AssignableRoles` in `Setup-GitHubOidc.ps1` and re-run the script.

**OIDC subject format.** Entra matches the `sub` claim exactly. Repos created since July 2026 use [immutable subject claims](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/), which include owner and repo IDs. Check the prefix:

```bash
gh api repos/WilliamBuckAustralia/SetEmailCategory/actions/oidc/customization/sub --jq .sub_claim_prefix
# repo:WilliamBuckAustralia@<owner-id>/SetEmailCategory@<repo-id>
```

A mismatch fails `azure/login` with `AADSTS700213`. The script reads the prefix with `gh` (or takes `-OidcSubjectPrefix`), migrates a name-based `github-<env>` credential and then removes it, and stops if `github-<env>` holds another repo's subject or the repo uses a custom template. After a repo move, delete the old credential and re-run the script:

```bash
az identity federated-credential delete -g <rg> --identity-name <identity> -n github-<env> --yes
```

Manual equivalent of the script:

```bash
ENV=prod; RG=<resource-group-name>; LOC=australiaeast; ID=id-github-setemailcat-$ENV
az identity create -g $RG -n $ID -l $LOC
PRINCIPAL=$(az identity show -g $RG -n $ID --query principalId -o tsv)
RG_ID=$(az group show -n $RG --query id -o tsv)
PREFIX=$(gh api repos/WilliamBuckAustralia/SetEmailCategory/actions/oidc/customization/sub --jq .sub_claim_prefix)
az identity federated-credential create -g $RG --identity-name $ID --name github-$ENV \
  --issuer https://token.actions.githubusercontent.com --subject "$PREFIX:environment:$ENV" \
  --audiences api://AzureADTokenExchange
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role Contributor --scope $RG_ID
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" --scope $RG_ID \
  --condition "<condition from Setup-GitHubOidc.ps1>" --condition-version 2.0
```

### 3.3 C: Function app identity

| Grant | Set by |
|---|---|
| Storage Blob Data Owner and Storage Table Data Contributor on the storage account | Bicep |
| Monitoring Metrics Publisher on Application Insights | Bicep |
| `Application Mail.ReadWrite` on **one** mailbox via Exchange RBAC for Applications (scope `SetEmailCategory - <address>`, assignment `SetEmailCategory - <functionAppName> - Mail.ReadWrite`) | `Grant-MailboxAccess.ps1` |

> **Never** grant this identity Graph `Mail.*` or Exchange Online `full_access_as_app` application permissions in Entra. They add to the Exchange scope and cover every mailbox ([lesson](lessons/2026-10-12-2038-exchange-rbac-for-apps-adds-to-entra-graph-grants.md)). `Grant-MailboxAccess.ps1` refuses to run if any exist.

The identity's object ID is in the deploy run summary (`functionAppPrincipalId`). Redeploying a deleted function app creates a new identity, so re-run `Grant-MailboxAccess.ps1`.

### 3.4 D and E: Entra app registrations

`Setup-EntraApps.ps1` creates both and writes `entra-output.<env>.json` (git-ignored, identifiers only).

| | D: API | E: Connector |
|---|---|---|
| Account types | Single tenant | Single tenant |
| Identifier URI / redirect URIs | `api://<apiAppClientId>` | `https://global.consent.azure-apim.net/redirect` plus the connector's own URI (add with `-ConnectorRedirectUri` after creating the connector) |
| Scope / permission | Exposes `user_impersonation`; v2.0 access tokens | Delegated `user_impersonation` on D, admin-consented (`AllPrincipals`) |
| Assignment required | Yes, caller group F (unless `-AllowAnyTenantUser`) | – |
| Secrets, Graph permissions | None | One client secret (12 months by default, printed once: vault it). Rotate with `-RotateSecret`. No Graph permissions. |

`apiAppClientId` (D) and `allowedClientApplicationIds` (E) go into the parameter file. Easy Auth rejects tokens issued to any other client with 403.

### 3.5 F: Caller security group

A security group (not Microsoft 365) containing service account G and the flow authors; pass its object ID to `-CallerGroupObjectId`. Non-members get `AADSTS50105`. The function uses its own mailbox permission, so members can change and read categories on any message in the mailbox: this group is the real access boundary.

### 3.6 G: Power Automate service account

The connection is a delegated sign-in, so the flow runs as whoever created it.

| Requirement | Detail |
|---|---|
| Account | Dedicated Entra user, not a person's account |
| Licence and access | Power Automate **Premium**; *Full Access* on the shared mailbox for the trigger |
| Group | Member of F |
| Conditional Access | Excluded from sign-in-frequency and compliant-device policies for the API app, or the connection expires on that schedule |
| Password | Long and vaulted. A reset breaks the connection (every run returns 401) until it's re-authenticated. |
| Ownership | Owns the flow and connection; add a human co-owner to the flow |

### 3.7 H: Dev app registration

For local `func start` only. A separate app registration with a client secret, **no** Graph permissions, scoped by Exchange RBAC to a **test** mailbox (the same commands `Grant-MailboxAccess.ps1` runs, with the dev app's `appId`). Credentials live only in the git-ignored `local.settings.json`.

---

## 4. Azure prerequisites

Runbook Phase 0.

| Item | Check |
|---|---|
| Flex Consumption in the region | `az functionapp list-flexconsumption-locations --query "[].name" -o tsv` |
| Resource providers | `Microsoft.Web`, `Microsoft.Storage`, `Microsoft.Insights`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`, `Microsoft.Network`, `Microsoft.App` (the last two for private networking): `az provider register --namespace <ns>` |
| Quota | Flex regional memory quota ≥ `maximumInstanceCount × instanceMemoryMB` (40 × 512 MB) |
| Azure Policy | The template already disables storage shared keys and public blob access, FTP/SCM basic auth and App Insights local auth, and enforces HTTPS/TLS 1.2. Policies denying user-assigned identities or conditional role assignments block `Setup-GitHubOidc.ps1`. |

---

## 5. GitHub configuration

Repo: [`WilliamBuckAustralia/SetEmailCategory`](https://github.com/WilliamBuckAustralia/SetEmailCategory) (GitHub Enterprise Cloud). Organisation or enterprise policy overrides repository settings where they conflict.

### 5.1 Environment variables

Set on the **environment** (not the repo) by `Setup-GitHubOidc.ps1 -SetGitHubVariables`, or by hand. They're identifiers, not secrets; no secrets are needed.

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | Client ID (not object ID) of identity B |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the RG |
| `AZURE_RESOURCE_GROUP` | `<resource-group-name>` |

```bash
for kv in AZURE_CLIENT_ID=<client-id> AZURE_TENANT_ID=<tenant-id> \
          AZURE_SUBSCRIPTION_ID=<sub-id> AZURE_RESOURCE_GROUP=<resource-group-name>; do
  gh variable set "${kv%%=*}" --env prod --repo WilliamBuckAustralia/SetEmailCategory --body "${kv#*=}"
done
```

### 5.2 Environment protection rules

The environment name must match the workflow's `environment:`, the `infra/env/<env>.bicepparam` file name and the federated credential subject. `-SetGitHubVariables` creates the environment without protection, so add:

| Setting | Value |
|---|---|
| Required reviewers | `<prod-approvers>` |
| Prevent self-review | On (turn off if there's only one reviewer, or nobody can deploy) |
| Deployment branches and tags | Branch `main` and tag `v*` (the runbook's rollback deploys a release tag) |

```bash
REPO=WilliamBuckAustralia/SetEmailCategory
REVIEWER_ID=$(gh api users/<reviewer-login> --jq .id)
gh api -X PUT repos/$REPO/environments/prod --input - <<EOF
{ "prevent_self_review": true, "reviewers": [{ "type": "User", "id": $REVIEWER_ID }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
EOF
gh api -X POST repos/$REPO/environments/prod/deployment-branch-policies -f name=main -f type=branch
gh api -X POST repos/$REPO/environments/prod/deployment-branch-policies -f name='v*' -f type=tag
```

### 5.3 Branch protection on `main`

Pushes to `main` that touch `src/`, `tests/`, `infra/` or the workflow deploy. Require a PR with one approval, the **`build`** status check (strict), and block force pushes and deletion:

```bash
gh api -X PUT repos/WilliamBuckAustralia/SetEmailCategory/branches/main/protection --input - <<'EOF'
{ "required_status_checks": { "strict": true, "contexts": ["build"] }, "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null, "allow_force_pushes": false, "allow_deletions": false }
EOF
```

A repository ruleset with the same rules works too.

### 5.4 Actions settings

| Setting | Value |
|---|---|
| Allowed actions | All, or at least those listed under [G1](#g1-github-organisation-policies) |
| Default workflow permissions | Read. The deploy job adds `id-token: write` itself; don't remove it. |
| OIDC subject | Default template, immutable subject on. If it changes, re-run `Setup-GitHubOidc.ps1`. |
| Fork PR workflows | Require approval, if forks are allowed. Fork PRs only run `build` and can't reach Azure. |

### 5.5 Tooling for whoever runs the setup

`az` with Bicep, PowerShell 7.2+ (or Cloud Shell), `gh` (with the `workflow` scope to push workflow changes, and SSO-authorised for the organisation if required), `pac`, and the ExchangeOnlineManagement module (installed by `Grant-MailboxAccess.ps1` if missing). The .NET 10 SDK and Functions Core Tools are only for local builds.

---

## 6. Configuration files

| File | Committed | Edit when |
|---|---|---|
| `infra/env/<env>.bicepparam` | Yes | Setting up or changing an environment |
| `infra/main.bicep`, `infra/modules/*.bicep` | Yes | Defaults, resources, app settings, Easy Auth, roles |
| `.github/workflows/deploy.yml` | Yes | Adding an environment (`workflow_dispatch` options) |
| `connector/*.json` | Yes (templates) | Changing the API or connector auth |
| `connector/dist/<env>/`, `entra-output.<env>.json`, `local.settings.json` | No (git-ignored) | Generated by scripts, or local only. Keep a team copy of `entra-output.<env>.json`. |

### 6.1 Parameter file

`infra/env/<env>.bicepparam` must match the GitHub environment name. The deploy job stops before what-if if any `'<...>'` placeholder remains.

| Parameter | Prod value / default | Notes |
|---|---|---|
| `environmentName` | `prod` | `dev`, `test` or `prod` only |
| `location` | `australiaeast` (default: RG location) | Must support Flex Consumption |
| `sharedMailboxAddress` | `<shared-mailbox-address>` | Same address as `Grant-MailboxAccess.ps1` |
| `apiAppClientId` | From `entra-output.<env>.json` | App D |
| `allowedClientApplicationIds` | `[ '<connectorClientId>' ]` | App E |
| `tags` | Mandatory tags | `workload` and `environment` are added automatically |
| `alertEmailAddresses` | Ops list (default `[]`, no alerts) | |
| `enablePrivateNetworking` | `true` (default `false`) | Required by policy (A6) |
| `vnetAddressPrefix` / `appSubnetPrefix` / `privateEndpointSubnetPrefix` | Placeholders (defaults `10.60.0.0/24` / `.0/26` / `.64/27`) | From IPAM (A8); subnets inside the VNet range |
| `createPrivateDnsZones` | `true` | `false` with central private DNS (A8) |
| `alwaysReadyInstances` | `0` | `1` removes cold starts at a fixed cost |
| `workload` | `setemailcat` | 3–12 lowercase letters/digits; used in every name |
| `maximumInstanceCount` / `httpPerInstanceConcurrency` | `40` / `50` | Minimum 40; keeps bursts on one instance |
| `graphConcurrencyPerInstance` / `requestDeadlineSeconds` | `4` / `90` | Graph's per-mailbox limit; must stay under Power Automate's 120 s |
| `instanceMemoryMB` / `logRetentionDays` / `throttlingAlertThreshold` | `512` / `90` / `10` | |

Names are `<type>-<workload>-<env>-<suffix>`, the suffix from `uniqueString(resourceGroup().id, workload, env)`. Check before committing:

```bash
az bicep build-params --file infra/env/prod.bicepparam --stdout > /dev/null
az deployment group what-if -g <resource-group-name> --parameters infra/env/prod.bicepparam
```

### 6.2 What Bicep sets on the function app

Overwritten on every deployment, so don't edit these in the portal.

- **App settings:** host storage over managed identity (`AzureWebJobsStorage__credential`, blob and table URIs); App Insights with Entra auth; `SharedMailbox__Address`; `Security__RequireAuthenticatedCaller` and `Security__RequireEasyAuthEnabled` = `true` (change only per runbook troubleshooting *500 Service misconfigured*); `Processing__MaxConcurrentGraphRequests` and `Processing__DeadlineSeconds` from parameters.
- **Easy Auth:** requires authentication (`Return401`, `/api/health` excluded); issuer `https://login.microsoftonline.com/<tenant>/v2.0`; audiences `<apiAppClientId>` and `api://<apiAppClientId>`; allowed clients `allowedClientApplicationIds`; token store off.
- **Platform:** HTTPS only, TLS 1.2, FTP and SCM basic auth disabled.

### 6.3 Workflow and connector

- **Workflow:** PRs build and test; pushes to `main` touching code, infra or the workflow build and deploy to `prod`; *Run workflow* picks an environment. One deployment per environment at a time. It reads the four variables and the Bicep outputs `functionAppName`, `functionAppHostName` and `functionAppPrincipalId`. The smoke test expects `/api/health` to report the new commit, `runningInAzure: true` and `acceptingRequests: true`, and an unauthenticated POST to return 401.
- **Connector:** `Build-ConnectorDefinition.ps1` fills `{{FUNCTION_HOST}}` (from the run summary), `{{CONNECTOR_CLIENT_ID}}`, `{{API_IDENTIFIER_URI}}`, `{{TENANT_ID}}` (from `entra-output.<env>.json`) and `{{PUBLISHER}}`, writing `connector/dist/<env>/`. Paste the client secret on the connector's **Security** tab; it's never in these files.

---

## 7. Setup order

| # | Step | Produces | Runbook |
|---|---|---|---|
| 0 | Close the open items in [section 1](#1-environment-decisions) | Final design, values | – |
| 1 | Register providers; confirm mailbox; create F and G | Group object ID | Phase 0 |
| 2 | `Setup-EntraApps.ps1 -Environment prod -CallerGroupObjectId <id>`; vault the secret | D, E, `entra-output.prod.json` | Phase 1 |
| 3 | Fill `prod.bicepparam`; commit via PR | Parameter file | Phase 2 |
| 4 | `Setup-GitHubOidc.ps1 -ResourceGroup <resource-group-name> -Location australiaeast ... -SetGitHubVariables` | B, 4 variables | Phase 3 |
| 5 | Environment protection and branch protection (sections 5.2, 5.3) | | Phase 3 |
| 6 | Run *build-and-deploy* | Function app, C | Phase 4 |
| 7 | `Grant-MailboxAccess.ps1`; wait 30 min – 2 h | Exchange scope | Phase 5 |
| 8 | Build and create the connector (in `<solution-unique-name>`), paste secret, add redirect URI | Connector | Phase 6 |
| 9 | Create the connection as G; build the flow | Flow | Phase 7 |
| 10 | End-to-end checks | | Phase 8 |

---

## 8. Adding a dev or test environment

Use `<test-mailbox-address>`, never the production mailbox. Run `Setup-EntraApps.ps1 -Environment dev`; copy `prod.bicepparam` to `dev.bicepparam` with dev values; run `Setup-GitHubOidc.ps1 -GitHubEnvironment dev -SetGitHubVariables`; add `dev` to the workflow's environment options; run `Grant-MailboxAccess.ps1` against the dev app; and create a separate connector, ideally in a separate Power Platform environment. Only `dev`, `test` and `prod` are accepted.

---

## 9. Verification commands

```bash
ENV=prod; RG=<resource-group-name>; ID=id-github-setemailcat-$ENV; REPO=WilliamBuckAustralia/SetEmailCategory

# GitHub: variables, environment protection, branch protection
gh variable list --env $ENV --repo $REPO
gh api repos/$REPO/environments/$ENV --jq '{protection_rules, deployment_branch_policy}'
gh api repos/$REPO/branches/main/protection --jq '.required_status_checks.contexts'

# OIDC: subject GitHub sends vs. what Azure trusts
gh api repos/$REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
az identity federated-credential list -g $RG --identity-name $ID --query "[].{name:name, subject:subject}" -o table

# Deployment identity roles: Contributor, and RBAC Administrator with a condition
P=$(az identity show -g $RG -n $ID --query principalId -o tsv)
az role assignment list --assignee $P --scope $(az group show -n $RG --query id -o tsv) \
  --query "[].{role:roleDefinitionName, conditional:condition!=null}" -o table
[ "$(az identity show -g $RG -n $ID --query clientId -o tsv)" = "$(gh variable get AZURE_CLIENT_ID --env $ENV --repo $REPO)" ] && echo "client id OK"

# Parameter file and Entra apps
grep -n "'<" infra/env/$ENV.bicepparam && echo "placeholders remain" || echo "parameter file OK"
az ad app list --display-name "SetEmailCategory" --query "[].{name:displayName, appId:appId}" -o table
az ad app credential list --id <connectorClientId> --query "[].{name:displayName, expires:endDateTime}" -o table

# After deployment: no app permissions on the function identity (expect empty), and health
FUNC=$(az functionapp list -g $RG --query "[0].name" -o tsv)
FP=$(az functionapp identity show -g $RG -n $FUNC --query principalId -o tsv)
az rest --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$FP/appRoleAssignments" --query "value[].appRoleId"
curl -s https://$(az functionapp show -g $RG -n $FUNC --query defaultHostName -o tsv)/api/health
```

---

## 10. Status (2026-10-18)

Nothing on the Azure, Entra ID, Exchange or Power Platform side has been set up. [Section 7](#7-setup-order) is the to-do list.

| Item | State |
|---|---|
| Environment decisions | Mostly answered. **Open:** naming convention (A6, template change), networking (A8), E2, G1, Flex availability and quota (A2), and the placeholder values. |
| `infra/env/prod.bicepparam` | `location` and `enablePrivateNetworking` set; placeholders remain for mailbox, app IDs, tags, alert email and the VNet ranges |
| GitHub (environment `prod`, variables, protection rules, branch protection, Actions settings) | Not checked since the move to `WilliamBuckAustralia`; migrations don't reliably carry these over. Before the move none were set and no deployment had succeeded. Check with section 9. |
| OIDC subject | Not checked; expected `repo:WilliamBuckAustralia@<owner-id>/SetEmailCategory@<repo-id>` |

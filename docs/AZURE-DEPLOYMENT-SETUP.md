# Azure deployment setup: accounts, GitHub settings and config files

This guide lists everything that has to be configured before `.github/workflows/deploy.yml` can deploy SetEmailCategory to Azure, and before the deployed function can be used. That covers:

- every account and identity involved (people, service principals, managed identities, the Power Automate service account),
- every GitHub setting (environments, variables, protection rules, branch protection, Actions/OIDC settings),
- every file in the repo that holds environment-specific configuration.

[RUNBOOK.md](RUNBOOK.md) is the step-by-step procedure (phases 0–8) and covers day-2 operations. This guide is the reference behind it: what each setting is, where its value comes from, how to set it with or without the scripts, and how to check it. The runbook phase is given for each item.

---

## Contents

1. [How a deployment authenticates](#1-how-a-deployment-authenticates)
2. [Accounts and identities](#2-accounts-and-identities)
3. [Azure subscription prerequisites](#3-azure-subscription-prerequisites)
4. [GitHub configuration](#4-github-configuration)
5. [Configuration files in the repo](#5-configuration-files-in-the-repo)
6. [Setup order checklist](#6-setup-order-checklist)
7. [Adding another environment](#7-adding-another-environment-dev-or-test)
8. [Verification commands](#8-verification-commands)
9. [Current state of this repo](#9-current-state-of-this-repo-2026-10-16)

---

## 1. How a deployment authenticates

```
GitHub Actions (deploy job, environment: prod)
   │  1. requests an OIDC token (permissions: id-token: write)
   │     sub = repo:akashic@648205/SetEmailCategory@1415034508:environment:prod
   ▼
Microsoft Entra ID
   │  2. matches the token to a federated credential on the
   │     user-assigned managed identity id-github-setemailcat-prod
   ▼
azure/login@v3 (client-id / tenant-id / subscription-id from GitHub environment variables)
   │  3. az deployment group create  →  infra/main.bicep + infra/env/prod.bicepparam
   │        Contributor on the RG creates the resources
   │        RBAC Administrator (ABAC-constrained) assigns the function's 4 data roles
   │  4. az functionapp deployment source config-zip  →  app.zip
   ▼
Function App (system-assigned managed identity)
   │  storage, App Insights: Azure RBAC roles assigned by Bicep
   │  Microsoft Graph: Exchange RBAC for Applications on ONE mailbox (Grant-MailboxAccess.ps1)
   ▼
Shared mailbox
```

**There are no secrets in GitHub.** The workflow needs four non-secret *variables* on the GitHub environment. Do not create an `AZURE_CREDENTIALS` secret or a service-principal client secret for deployment.

---

## 2. Accounts and identities

### 2.1 Summary

| # | Identity | Kind | Created by | Used for | Secret? |
|---|---|---|---|---|---|
| A | Admin people (several roles) | Entra users | Already exist | Running the one-time setup scripts | – |
| B | `id-github-setemailcat-<env>` | User-assigned managed identity + federated credential | `scripts/Setup-GitHubOidc.ps1` | GitHub Actions deploying to Azure | No (OIDC) |
| C | `func-setemailcat-<env>-<suffix>` | System-assigned managed identity | Bicep (`infra/modules/functionApp.bicep`) | Function → Storage, App Insights, Graph | No |
| D | *SetEmailCategory API (<env>)* | Entra app registration + enterprise app | `scripts/Setup-EntraApps.ps1` | The audience Easy Auth validates tokens for | No |
| E | *SetEmailCategory Connector (<env>)* | Entra app registration + enterprise app | `scripts/Setup-EntraApps.ps1` | OAuth client of the Power Platform custom connector | **Yes**: one client secret, held only in Power Platform |
| F | Caller group, e.g. `SG-SetEmailCategory-Users` | Entra security group | Admin (manual) | Who may obtain a token for the API | – |
| G | Power Automate service account | Entra user (licensed) | Admin (manual) | Owns the flow and the connector connection | Password managed by identity team |
| H | Dev app registration (optional) | Entra app registration | Developer (manual) | Local `func start` calling Graph against a **test** mailbox | Yes, in `local.settings.json` only |

### 2.2 A: Admin roles needed to run the setup

No single person needs all of these. Hand each phase to the right admin.

| Task | Script / place | Minimum role |
|---|---|---|
| Register resource providers, create RG, deployment identity and its role assignments | `Setup-GitHubOidc.ps1` | **Owner** on the subscription (or **Contributor** + **User Access Administrator**/**RBAC Administrator** on the subscription or RG) |
| Write GitHub environment and variables (`-SetGitHubVariables`) | `gh` CLI | **Admin** on the GitHub repo |
| Create app registrations D and E, admin consent, group assignment | `Setup-EntraApps.ps1` | Entra **Application Administrator** or **Cloud Application Administrator**. Granting the `AllPrincipals` consent to your own API is within that role. |
| Create caller group F, service account G | Entra admin centre | **Groups Administrator** / **User Administrator** |
| Exchange scoping of identity C | `Grant-MailboxAccess.ps1` | Exchange **Organization Management** (or Entra **Exchange Administrator**), plus Azure CLI read access to the function app |
| Create custom connector | `pac connector create` / maker portal | Power Platform **Environment Maker** in the target environment |
| DLP policy | Power Platform admin centre | **Power Platform Administrator** |

### 2.3 B: GitHub deployment identity

Created by [`scripts/Setup-GitHubOidc.ps1`](../scripts/Setup-GitHubOidc.ps1) (runbook Phase 3).

| Property | Value |
|---|---|
| Resource | `Microsoft.ManagedIdentity/userAssignedIdentities` |
| Name | `id-github-setemailcat-<env>` (override with `-IdentityName`) |
| Location / RG | The deployment resource group, e.g. `rg-setemailcat-prod`. The script creates the RG if it doesn't exist, in `-Location`. **That region is where everything deploys**, because `main.bicep` defaults `location` to the RG's region. |
| Federated credential issuer | `https://token.actions.githubusercontent.com` |
| Federated credential audience | `api://AzureADTokenExchange` |
| Federated credential subject | **`repo:akashic@648205/SetEmailCategory@1415034508:environment:<env>`** (see [OIDC subject format](#oidc-subject-format)) |
| Role 1 | **Contributor**, scope = the resource group only |
| Role 2 | **Role Based Access Control Administrator**, scope = the resource group, with an ABAC condition (below) |

**Why the RBAC Administrator role, and why it's constrained.** The Bicep template assigns four roles to the function's managed identity, which requires `Microsoft.Authorization/roleAssignments/write`. Contributor doesn't include that. Rather than grant Owner or User Access Administrator, the script grants RBAC Administrator with a condition that allows creating or deleting assignments only for:

| Role | ID |
|---|---|
| Storage Blob Data Owner | `b7e6dc6d-f1e8-4753-8033-0f276bb0955b` |
| Storage Queue Data Contributor | `974c5e8b-45b9-4653-ba55-5f855dd0fb88` |
| Storage Table Data Contributor | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` |
| Monitoring Metrics Publisher | `3913510d-42f4-4e42-8a64-420c390055eb` |

and only to principals of type `ServicePrincipal`. **If you add a role assignment to the Bicep, add its role ID to `$AssignableRoles` in `Setup-GitHubOidc.ps1` and re-run the script**, or the deployment fails with an authorization error at the role-assignment step.

The subject is environment-scoped, so **only a job that declares `environment: <env>` can use this identity**. A PR build, or a job without the environment, can't log in to Azure. That's what makes GitHub environment protection rules (section 4.2) effective.

#### OIDC subject format

Entra only accepts the token if its `sub` claim matches the federated credential's subject exactly. This repository has GitHub's [immutable subject claims](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/) turned on, so the subject includes the owner and repo IDs as well as their names:

```bash
$ gh api repos/akashic/SetEmailCategory/actions/oidc/customization/sub
{"use_default":true,"use_immutable_subject":true,"sub_claim_prefix":"repo:akashic@648205/SetEmailCategory@1415034508"}
```

The deploy job's token therefore carries `sub = repo:akashic@648205/SetEmailCategory@1415034508:environment:prod`. The older name-based form (`repo:akashic/SetEmailCategory:environment:prod`) would never match and `azure/login` would fail with `AADSTS700213: No matching federated identity record found`.

`Setup-GitHubOidc.ps1` handles this for you:

- It reads `sub_claim_prefix` from that API with `gh`, so the subject matches whichever format the repo uses. If `gh` isn't available, pass the prefix with `-OidcSubjectPrefix`.
- If `github-<env>` already exists with the name-based subject (created by an earlier version of the script), it updates it in place.
- Once a credential with the immutable subject exists, it deletes any credential still holding the name-based subject. That follows [Microsoft's migration guidance](https://learn.microsoft.com/entra/workload-id/workload-identities-github-immutable-subjects): a name-based trust would also accept a future repo that reuses this name.
- It stops with an error if `github-<env>` holds some other subject, or if the repo uses a custom OIDC subject template. Fix those by hand.

If the repo is ever transferred or recreated, its IDs change: re-run the script to update the credential.

#### Manual equivalent (no script)

```bash
SUB=<subscription-id>; ENV=prod; RG=rg-setemailcat-$ENV; LOC=<region>; ID=id-github-setemailcat-$ENV
az account set -s $SUB
az group create -n $RG -l $LOC
az identity create -g $RG -n $ID -l $LOC
PRINCIPAL=$(az identity show -g $RG -n $ID --query principalId -o tsv)
CLIENT=$(az identity show -g $RG -n $ID --query clientId -o tsv)
RG_ID=$(az group show -n $RG --query id -o tsv)

PREFIX=$(gh api repos/akashic/SetEmailCategory/actions/oidc/customization/sub --jq .sub_claim_prefix)
az identity federated-credential create -g $RG --identity-name $ID --name github-$ENV \
  --issuer https://token.actions.githubusercontent.com --subject "$PREFIX:environment:$ENV" \
  --audiences api://AzureADTokenExchange
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role Contributor --scope $RG_ID
# RBAC Administrator with the ABAC condition: copy $condition from Setup-GitHubOidc.ps1
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" --scope $RG_ID \
  --condition "<condition from the script>" --condition-version 2.0
```

### 2.4 C: Function App managed identity

Created and configured by Bicep; nothing to do by hand except the Exchange step.

| Grant | Where | Set by |
|---|---|---|
| Storage Blob Data Owner, Queue Data Contributor, Table Data Contributor on the storage account | Azure RBAC | `functionApp.bicep` (`storageRoleAssignments`) |
| Monitoring Metrics Publisher on Application Insights | Azure RBAC | `functionApp.bicep` (`metricsPublisher`) |
| Deployment package container read (Flex `functionAppConfig.deployment.storage`) | Uses the blob role above | `functionApp.bicep` |
| `Application Mail.ReadWrite` on **one** shared mailbox | Exchange Online RBAC for Applications (management scope `SetEmailCategory - <address>`, role assignment `SetEmailCategory - <functionAppName> - Mail.ReadWrite`) | `scripts/Grant-MailboxAccess.ps1` (runbook Phase 5) |
| **No** Microsoft Graph application permissions in Entra | – | `Grant-MailboxAccess.ps1` refuses to run if any exist |

The identity's object ID is printed in the deploy run summary and is a Bicep output (`functionAppPrincipalId`).

> **Never** add `Mail.ReadWrite` (or any `Mail.*`) as a Graph application permission to this identity in Entra. Exchange RBAC grants are *added* to Entra grants, so it would give the function access to every mailbox. See [the lesson](lessons/2026-10-12-2038-exchange-rbac-for-apps-adds-to-entra-graph-grants.md).

The identity is recreated if the function app is deleted and redeployed. Its new object ID needs `Grant-MailboxAccess.ps1` run again.

### 2.5 D and E: Entra app registrations

Created by [`scripts/Setup-EntraApps.ps1`](../scripts/Setup-EntraApps.ps1) (runbook Phase 1, plus Phase 6 step 4 for the redirect URI). It writes `entra-output.<env>.json` (git-ignored; identifiers only).

**D: SetEmailCategory API (<env>)**

| Setting | Value | Why |
|---|---|---|
| Supported account types | Single tenant (`AzureADMyOrg`) | |
| Application ID URI | `api://<apiAppClientId>` | Connector's resource URL; Easy Auth accepts it as audience |
| Exposed scope | `user_impersonation` (type User), stable ID derived from workload/env | Connector requests it |
| `api.requestedAccessTokenVersion` | `2` | Easy Auth's issuer is the v2.0 endpoint (`.../<tenant>/v2.0`) |
| Enterprise app → *Assignment required* | Yes, when `-CallerGroupObjectId` is given | Only group members can get a token |
| Users and groups | Caller group F, default access role | |
| API permissions / secrets | **None** | The API app never calls anything |

**E: SetEmailCategory Connector (<env>)**

| Setting | Value | Why |
|---|---|---|
| Supported account types | Single tenant | |
| Web redirect URIs | `https://global.consent.azure-apim.net/redirect` **and** the connector's own URI (`.../redirect/<connector-specific-id>`) | The per-connector URI is only known after the connector exists; add it with `-ConnectorRedirectUri` |
| API permissions | API app D → `user_impersonation` (delegated) | |
| Admin consent | `oauth2PermissionGrant`, `consentType = AllPrincipals` | Users aren't prompted |
| Client secret | One, 12-month validity by default (`-SecretValidityMonths`), display name `power-platform-connector-<yyyyMMdd>` | **Printed once.** Store it in your vault and record the expiry date. Rotate with `-RotateSecret` (runbook *Secret rotation*). |
| Microsoft Graph permissions | **None** | |

Two values from these registrations go into the Bicep parameter file (section 5.1): `apiAppClientId` (D) and `allowedClientApplicationIds` (E's client ID). Easy Auth rejects tokens issued to any other client with 403.

### 2.6 F: Caller security group

Optional but recommended (runbook Phase 0, step 4). Create a **security** group (not Microsoft 365), e.g. `SG-SetEmailCategory-Users`, containing the Power Automate service account (G) and any flow authors. Pass its object ID to `Setup-EntraApps.ps1 -CallerGroupObjectId`. Users outside it get `AADSTS50105` when creating a connection.

### 2.7 G: Power Automate service account

The custom connector's connection holds a **delegated** sign-in, so the flow runs as whoever created the connection. Use a dedicated account (runbook Phase 6, step 6):

| Requirement | Detail |
|---|---|
| Account type | Dedicated Entra user, e.g. `svc-setemailcat@contoso.com`. Not a person's account. |
| Licence | Power Automate **Premium** (custom connectors are premium). Office 365 licence or delegated access to read the shared mailbox for the trigger. |
| Group membership | Caller group F |
| Shared mailbox | *Full Access* on the shared mailbox, so the *When a new email arrives in a shared mailbox (V2)* trigger can read it |
| Conditional Access | Exclude from **sign-in frequency** and **compliant-device** policies for the *SetEmailCategory API* app, or the connection expires on that schedule. Keep MFA/location policies your identity team requires; the connection survives those as long as the refresh token stays valid. |
| Password | Long, vaulted, non-expiring or rotated on a schedule with the connection re-authenticated straight afterwards. A password reset breaks the connection (every run returns 401). |
| Ownership | Owner of the flow and the connection. Add a second human co-owner to the flow for break-glass. |

### 2.8 H: Dev app registration (local development only)

Only needed to call Graph from `func start`. Create a separate app registration with a client secret, give it **no** Graph permissions in Entra, and scope it with Exchange RBAC to a **test** mailbox (the same `New-ManagementScope` / `New-ManagementRoleAssignment` commands `Grant-MailboxAccess.ps1` runs, with the dev app's `appId`). Its credentials go only in `src/SetEmailCategory/local.settings.json`, which is git-ignored. It is never used by the pipeline.

---

## 3. Azure subscription prerequisites

Runbook Phase 0.

| Item | Command / check |
|---|---|
| Region supports Flex Consumption | `az functionapp list-flexconsumption-locations --query "[].name" -o tsv` |
| Resource providers registered | `Microsoft.Web`, `Microsoft.Storage`, `Microsoft.Insights`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`, and `Microsoft.Network` + `Microsoft.App` if `enablePrivateNetworking = true`. `az provider register --namespace <ns>` |
| Azure Policy | The template already disables storage shared keys and public blob access, FTP and SCM basic auth, App Insights local auth, and enforces TLS 1.2 / HTTPS. If policy requires more (tags, diagnostic settings, private endpoints), set `tags` / `enablePrivateNetworking` in the parameter file. Policies that *deny* user-assigned identities or role assignments with conditions will block Phase 3. |
| Quota | Flex Consumption regional memory quota must cover `maximumInstanceCount × instanceMemoryMB` (40 × 512 MB by default). |

---

## 4. GitHub configuration

Repo: `akashic/SetEmailCategory` (public).

### 4.1 Environment variables (required)

The deploy job reads these with `${{ vars.* }}`. Set them on the **environment**, not the repo, so each environment can point at a different subscription/RG.

| Variable | Value | Source |
|---|---|---|
| `AZURE_CLIENT_ID` | **Client ID** (not principal/object ID) of `id-github-setemailcat-<env>` | `az identity show -g <rg> -n <id> --query clientId -o tsv` |
| `AZURE_TENANT_ID` | Entra tenant ID | `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the RG | `az account show --query id -o tsv` |
| `AZURE_RESOURCE_GROUP` | e.g. `rg-setemailcat-prod` | The `-ResourceGroup` you passed to `Setup-GitHubOidc.ps1` |

These are identifiers, not secrets. They appear masked in logs only because `azure/login` masks the client ID.

Set them with `Setup-GitHubOidc.ps1 -SetGitHubVariables`, or by hand:

```bash
for kv in AZURE_CLIENT_ID=<client-id> AZURE_TENANT_ID=<tenant-id> \
          AZURE_SUBSCRIPTION_ID=<sub-id> AZURE_RESOURCE_GROUP=rg-setemailcat-prod; do
  gh variable set "${kv%%=*}" --env prod --repo akashic/SetEmailCategory --body "${kv#*=}"
done
```

UI: **Settings → Environments → prod → Environment variables → Add variable**.

**No secrets are required.** If any `AZURE_*` secrets exist from earlier experiments, delete them.

### 4.2 Environment protection rules (recommended)

The environment name must match exactly: the workflow's `environment:` value, the `infra/env/<env>.bicepparam` filename, and the federated credential subject.

| Setting | Recommended value | Why |
|---|---|---|
| **Required reviewers** | The ops lead plus one backup (users or a team) | A human approves each production deployment |
| **Prevent self-review** | On | The person who pushed can't approve their own deployment |
| **Deployment branches and tags** | *Selected branches and tags*: branch `main`, tag `v*` | Stops other branches deploying. Include `v*` tags, or the runbook's rollback procedure (*Run workflow* on an earlier release tag) is rejected. |
| Wait timer | 0 | |
| Environment secrets | None | |

UI: **Settings → Environments → prod**. Or with the API:

```bash
REPO=akashic/SetEmailCategory
REVIEWER_ID=$(gh api users/<reviewer-login> --jq .id)

gh api -X PUT repos/$REPO/environments/prod --input - <<EOF
{
  "prevent_self_review": true,
  "reviewers": [{ "type": "User", "id": $REVIEWER_ID }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
gh api -X POST repos/$REPO/environments/prod/deployment-branch-policies -f name=main -f type=branch
gh api -X POST repos/$REPO/environments/prod/deployment-branch-policies -f name='v*' -f type=tag
```

Note that `Setup-GitHubOidc.ps1 -SetGitHubVariables` creates the environment with **no** protection rules; add them afterwards. A single-maintainer repo with self-review prevention on can't deploy, so turn that off if you're the only reviewer.

### 4.3 Branch protection on `main` (recommended)

Every push to `main` that touches `src/`, `tests/`, `infra/` or the workflow deploys, so protect it:

| Rule | Value |
|---|---|
| Require a pull request before merging | On, 1 approval |
| Require status checks to pass | On; required check **`build`** (the job name in `deploy.yml`, which runs on every PR) |
| Require branches to be up to date | On |
| Block force pushes and deletion | On |

```bash
gh api -X PUT repos/akashic/SetEmailCategory/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["build"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

Or use a repository ruleset (**Settings → Rules → Rulesets**) with the same rules.

### 4.4 Actions and OIDC settings

| Setting | Where | Required value |
|---|---|---|
| Actions enabled | Settings → Actions → General | Allow actions. The workflow uses `actions/checkout`, `actions/setup-dotnet`, `actions/upload-artifact`, `actions/download-artifact` and `azure/login`; if you restrict to selected actions, allow those. |
| Default workflow permissions | Settings → Actions → General | **Read repository contents** (currently set). The workflow declares `contents: read` at the top and adds `id-token: write` only on the deploy job, which is what lets it request an OIDC token. Don't remove that line. |
| OIDC subject claim | `gh api repos/<repo>/actions/oidc/customization/sub` | Leave as is (default template, immutable subject on). If you change the template or the immutable setting, re-run `Setup-GitHubOidc.ps1` so the federated credential subject matches again. |
| Fork PR workflows | Settings → Actions → General | Require approval for first-time contributors (default for public repos). Fork PRs only run the `build` job and can't reach Azure. |

### 4.5 Local tooling for whoever runs the setup

| Tool | Notes |
|---|---|
| Azure CLI (`az`) with Bicep | `az bicep install` |
| PowerShell 7.2+ | All scripts. On Apple silicon use `brew install powershell` (formula), not the stale cask. Azure Cloud Shell works too. |
| GitHub CLI (`gh`) | Needed by `Setup-GitHubOidc.ps1` (to read the OIDC subject format and for `-SetGitHubVariables`) and for the API calls above. To push changes under `.github/workflows/`, the token needs the `workflow` scope: `gh auth refresh -h github.com -s workflow`. |
| ExchangeOnlineManagement module | Installed by `Grant-MailboxAccess.ps1` if missing |
| Power Platform CLI (`pac`) | For `pac connector create` |
| .NET 10 SDK, Azure Functions Core Tools 4 | Local build/run only |

---

## 5. Configuration files in the repo

| File | Committed? | Per environment? | Edit when |
|---|---|---|---|
| `infra/env/<env>.bicepparam` | Yes | Yes | Setting up an environment; changing mailbox, apps, alerting, scale |
| `infra/main.bicep` | Yes | No | Changing defaults or adding resources |
| `infra/modules/functionApp.bicep` | Yes | No | App settings, Easy Auth, role assignments |
| `.github/workflows/deploy.yml` | Yes | Environment list | Adding an environment |
| `connector/apiDefinition.swagger.json`, `connector/apiProperties.json` | Yes (templates) | No | Changing the API surface or connector auth |
| `connector/dist/<env>/` | **No** (git-ignored) | Yes | Generated by `Build-ConnectorDefinition.ps1` |
| `entra-output.<env>.json` | **No** (git-ignored) | Yes | Generated by `Setup-EntraApps.ps1` |
| `src/SetEmailCategory/local.settings.json` | **No** (git-ignored) | Local | Local development |
| `global.json`, `src/SetEmailCategory/host.json` | Yes | No | SDK or host changes |

### 5.1 `infra/env/<env>.bicepparam` (required, per environment)

The deploy job passes `infra/env/$ENVIRONMENT.bicepparam`, so the file name must match the GitHub environment name. All values are identifiers, so commit the file. **Every `'<...>'` placeholder must be replaced before the first deployment.** Nothing checks them: a placeholder either fails the deployment or produces an app that rejects or fails every call.

| Parameter | Required | Value | Source |
|---|---|---|---|
| `environmentName` | Yes | `dev` / `test` / `prod` (only these are allowed) | Matches file name |
| `sharedMailboxAddress` | Yes | Primary SMTP address of the shared mailbox | Exchange admin centre. Must be the same address used in `Grant-MailboxAccess.ps1`. |
| `apiAppClientId` | Yes | Client ID of app D | `entra-output.<env>.json` → `apiAppClientId` |
| `allowedClientApplicationIds` | Yes | `[ '<client ID of app E>' ]` | `entra-output.<env>.json` → `connectorClientId` |
| `tags` | No (default `{}`) | Your mandatory tags. `workload` and `environment` are added automatically. | Your organisation's policy |
| `alertEmailAddresses` | No (default `[]`) | Ops distribution list. Empty = no alert resources. | |
| `enablePrivateNetworking` | No (default `false`) | `true` puts storage behind private endpoints | Runbook *Private networking* |
| `alwaysReadyInstances` | No (default `0`) | `1` removes cold starts at a fixed cost | |

Parameters with defaults in `main.bicep` that you can also set here:

| Parameter | Default | Notes |
|---|---|---|
| `workload` | `setemailcat` | 3–12 lowercase letters/digits; part of every resource name |
| `location` | RG location | Must support Flex Consumption |
| `instanceMemoryMB` | `512` | 512 / 2048 / 4096 |
| `maximumInstanceCount` | `40` | Minimum 40 (enforced). Lower values make Flex reject bursts. |
| `httpPerInstanceConcurrency` | `50` | Keeps bursts on one instance |
| `graphConcurrencyPerInstance` | `4` | Graph's per-mailbox limit |
| `requestDeadlineSeconds` | `90` | Must stay under Power Automate's 120 s |
| `vnetAddressPrefix` / `appSubnetPrefix` / `privateEndpointSubnetPrefix` | `10.60.0.0/24` / `.0/26` / `.64/27` | Only with private networking; pick from your IPAM if peering |
| `createPrivateDnsZones` | `true` | `false` if a hub manages `privatelink.*` zones |
| `logRetentionDays` | `90` | 30–730 |

Resource names are derived as `<type>-<workload>-<env>-<6-char suffix>`, with the suffix from `uniqueString(resourceGroup().id, workload, env)`. They stay stable as long as the RG, workload and environment don't change.

Check the file compiles before committing:

```bash
az bicep build-params --file infra/env/prod.bicepparam --stdout > /dev/null
az deployment group what-if -g rg-setemailcat-prod --parameters infra/env/prod.bicepparam
```

### 5.2 Function App settings (`infra/modules/functionApp.bicep`)

Set by Bicep on every deployment. **Don't change them in the portal**: the next deployment overwrites them.

| App setting | Value | From |
|---|---|---|
| `AzureWebJobsStorage__credential` | `managedidentity` | Fixed |
| `AzureWebJobsStorage__blobServiceUri` / `__queueServiceUri` / `__tableServiceUri` | Storage endpoints | Storage module |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights connection string | Monitoring module |
| `APPLICATIONINSIGHTS_AUTHENTICATION_STRING` | `Authorization=AAD` | Fixed (local auth is off) |
| `SharedMailbox__Address` | `sharedMailboxAddress` | Parameter file |
| `Security__RequireAuthenticatedCaller` | `true` | Fixed |
| `Security__RequireEasyAuthEnabled` | `true` | Fixed. Only change per runbook troubleshooting *500 Service misconfigured*. |
| `Processing__MaxConcurrentGraphRequests` | `graphConcurrencyPerInstance` | Parameter |
| `Processing__DeadlineSeconds` | `requestDeadlineSeconds` | Parameter |

App Service Authentication (`authsettingsV2`), also from this file:

| Setting | Value |
|---|---|
| Require authentication | Yes, `Return401`; `/api/health` excluded (used by the smoke test) |
| Issuer | `https://login.microsoftonline.com/<tenant>/v2.0` |
| Client ID | `apiAppClientId` |
| Allowed audiences | `<apiAppClientId>`, `api://<apiAppClientId>` |
| Allowed client applications | `allowedClientApplicationIds` |
| Token store | Off |

Platform settings: HTTPS only, TLS 1.2, FTPS disabled, FTP and SCM basic publishing credentials disabled (so deployments must use Entra ID, which is what the pipeline does).

### 5.3 `.github/workflows/deploy.yml`

You normally don't edit this. What it expects:

| Item | Detail |
|---|---|
| Triggers | PRs to `main` (build/test only); pushes to `main` touching `src/**`, `tests/**`, `infra/**` or the workflow (build + deploy to `prod`); manual `workflow_dispatch` with an `environment` choice |
| Doc-only changes | Don't trigger a deployment (paths filter) |
| Environment list | `workflow_dispatch.inputs.environment.options: [prod]`. Add new environment names here. Pushes always deploy to `prod`. |
| Variables read | `vars.AZURE_CLIENT_ID`, `vars.AZURE_TENANT_ID`, `vars.AZURE_SUBSCRIPTION_ID`, `vars.AZURE_RESOURCE_GROUP` |
| Permissions | Top-level `contents: read`; deploy job adds `id-token: write` |
| Concurrency | One deployment per environment at a time, never cancelled mid-run |
| Bicep outputs consumed | `functionAppName`, `functionAppHostName`, `functionAppPrincipalId`. Keep these output names in `main.bicep`. |
| Smoke test | `/api/health` must report the new commit SHA, `runningInAzure: true` and `acceptingRequests: true`; an unauthenticated POST must return 401 |

### 5.4 Connector templates (`connector/`)

`apiDefinition.swagger.json` and `apiProperties.json` are templates. `scripts/Build-ConnectorDefinition.ps1` replaces these tokens and writes `connector/dist/<env>/` (runbook Phase 6):

| Token | Replaced with |
|---|---|
| `{{FUNCTION_HOST}}` | `-FunctionHostName` (from the deploy run summary, e.g. `func-setemailcat-prod-abc123.azurewebsites.net`) |
| `{{CONNECTOR_CLIENT_ID}}` | `entra-output.<env>.json` → `connectorClientId` |
| `{{API_IDENTIFIER_URI}}` | `entra-output.<env>.json` → `apiIdentifierUri` |
| `{{TENANT_ID}}` | `entra-output.<env>.json` → `tenantId` |
| `{{PUBLISHER}}` | `-Publisher` |

The client secret is **not** in these files. Paste it on the connector's **Security** tab after creating it.

### 5.5 Generated and local-only files

- **`entra-output.<env>.json`**: written by `Setup-EntraApps.ps1`; holds tenant ID, client IDs, identifier URI and redirect URIs. Not secret, but git-ignored because it's environment-specific. Keep a copy somewhere the team can reach (e.g. alongside the vaulted client secret), since `Build-ConnectorDefinition.ps1` needs it.
- **`src/SetEmailCategory/local.settings.json`**: copy from `local.settings.json.example`. Holds the dev app's secret (identity H). Never commit it.
- **`global.json`**: pins SDK 10.0.x (`rollForward: latestFeature`). The workflow installs `10.0.x`.
- **`host.json`**: Functions host v2, OpenTelemetry mode. Nothing environment-specific.

---

## 6. Setup order checklist

The order matters: some values only exist after an earlier step.

| # | Step | Produces | Runbook |
|---|---|---|---|
| 1 | Pick region, register providers, confirm shared mailbox, create caller group F and service account G | Region, mailbox address, group object ID | Phase 0 |
| 2 | `Setup-EntraApps.ps1 -Environment prod -CallerGroupObjectId <id>`; vault the client secret | Apps D and E, `entra-output.prod.json` | Phase 1 |
| 3 | Fill `infra/env/prod.bicepparam`; commit via PR | Parameter file | Phase 2 |
| 4 | `Setup-GitHubOidc.ps1 ... -SetGitHubVariables` | Identity B, RG, 4 GitHub variables | Phase 3 |
| 5 | Set environment protection rules and branch protection (sections 4.2, 4.3) | | Phase 3 |
| 6 | Run *build-and-deploy* (Actions → Run workflow) | Function app, identity C; summary shows app name, host name, principal ID | Phase 4 |
| 7 | `Grant-MailboxAccess.ps1`; wait 30 min – 2 h | Exchange scope for C | Phase 5 |
| 8 | `Build-ConnectorDefinition.ps1`, `pac connector create`, paste secret, `Setup-EntraApps.ps1 -ConnectorRedirectUri ...`, DLP | Custom connector | Phase 6 |
| 9 | Create connection as service account G, build flow | Flow | Phase 7 |
| 10 | End-to-end checks | | Phase 8 |

---

## 7. Adding another environment (dev or test)

| Item | Change |
|---|---|
| Shared mailbox | A **separate test mailbox**. Never point non-production at production. |
| Apps D, E | `Setup-EntraApps.ps1 -Environment dev` (creates *SetEmailCategory API (dev)* / *Connector (dev)*) |
| Parameter file | Copy `prod.bicepparam` to `infra/env/dev.bicepparam`, set `environmentName = 'dev'` and the dev values |
| Resource group + identity B | `Setup-GitHubOidc.ps1 -ResourceGroup rg-setemailcat-dev -GitHubEnvironment dev -SetGitHubVariables` |
| GitHub environment | `dev`, with its own four variables. Protection rules optional; you may allow feature branches. |
| Workflow | Add `dev` to `workflow_dispatch.inputs.environment.options` |
| Exchange | `Grant-MailboxAccess.ps1` against the dev function app and test mailbox |
| Connector | Separate connector per environment, ideally in a separate Power Platform environment |

`environmentName`, `-Environment` and `-GitHubEnvironment` only accept `dev`, `test` and `prod`.

---

## 8. Verification commands

```bash
ENV=prod; RG=rg-setemailcat-$ENV; ID=id-github-setemailcat-$ENV; REPO=akashic/SetEmailCategory

# GitHub: environment, variables, protection
gh variable list --env $ENV --repo $REPO
gh api repos/$REPO/environments/$ENV --jq '{protection_rules, deployment_branch_policy}'
gh api repos/$REPO/environments/$ENV/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
gh api repos/$REPO/branches/main/protection --jq '.required_status_checks.contexts'

# OIDC: the subject GitHub will send vs. what Azure trusts
gh api repos/$REPO/actions/oidc/customization/sub --jq .sub_claim_prefix
az identity federated-credential list -g $RG --identity-name $ID --query "[].{name:name, subject:subject}" -o table

# Deployment identity roles (expect Contributor and Role Based Access Control Administrator with a condition)
P=$(az identity show -g $RG -n $ID --query principalId -o tsv)
az role assignment list --assignee $P --scope $(az group show -n $RG --query id -o tsv) \
  --query "[].{role:roleDefinitionName, conditional:condition!=null}" -o table

# Variables match the identity
[ "$(az identity show -g $RG -n $ID --query clientId -o tsv)" = "$(gh variable get AZURE_CLIENT_ID --env $ENV --repo $REPO)" ] && echo "client id OK"

# Parameter file has no placeholders left
grep -n "'<" infra/env/$ENV.bicepparam && echo "placeholders remain" || echo "parameter file OK"

# Entra apps
az ad app list --display-name "SetEmailCategory" --query "[].{name:displayName, appId:appId}" -o table
az ad app credential list --id <connectorClientId> --query "[].{name:displayName, expires:endDateTime}" -o table

# After the first deployment: function identity has no Graph app permissions (expect empty)
FUNC=$(az functionapp list -g $RG --query "[0].name" -o tsv)
FP=$(az functionapp identity show -g $RG -n $FUNC --query principalId -o tsv)
az rest --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$FP/appRoleAssignments" --query "value[].appRoleId"

# Health endpoint (anonymous)
curl -s https://$(az functionapp show -g $RG -n $FUNC --query defaultHostName -o tsv)/api/health
```

---

## 9. Current state of this repo (2026-10-16)

A snapshot, so you know what's left. Re-check with section 8.

| Item | State | To do |
|---|---|---|
| GitHub environment `prod` | Exists | – |
| `prod` variables | **None set** | Section 4.1. The only deploy run so far ([run 38204564920](https://github.com/akashic/SetEmailCategory/actions/runs/38204564920), 2026-10-12) failed at `azure/login` with "Not all values are present. Ensure 'client-id' and 'tenant-id' are supplied." |
| `prod` protection rules | **None**; any branch can deploy | Section 4.2 |
| Branch protection on `main` | **None** | Section 4.3 |
| OIDC subject | Immutable format on (`repo:akashic@648205/SetEmailCategory@1415034508`) | Nothing extra: `Setup-GitHubOidc.ps1` registers the matching subject ([OIDC subject format](#oidc-subject-format)) |
| `infra/env/prod.bicepparam` | **Placeholders** for mailbox, app IDs, tags, alert email | Section 5.1 |
| Default workflow permissions | Read | – |
| Repository secrets | None needed | – |

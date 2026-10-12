---
id: 2026-10-12-2038-exchange-rbac-for-apps-adds-to-entra-graph-grants
title: Exchange RBAC for Applications scoping is void if Entra also grants Graph mail permissions
applies_when: >
  scoping an app or managed identity to specific mailboxes with Exchange Online RBAC for
  Applications (management scopes) instead of tenant-wide Graph Mail.* permissions
rule: >
  When restricting an app to certain mailboxes with Exchange RBAC for Applications, make
  sure its service principal has no Microsoft Graph Mail.* application permission
  consented in Entra ID, and check this automatically before assigning the role, because
  the two grants are added together and the Entra grant reaches every mailbox.
lesson_type: pitfall
phase: design
domain: [identity, security]
tech: [exchange-online, entra-id, microsoft-graph]
scope: this-stack
cost_if_ignored: project-level
confidence: one-off
status: active
superseded_by:
expires:
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: direct-experience
  evidence: >
    commit 394bbbf (scripts/Grant-MailboxAccess.ps1, lines 8-10 and 55-61); Microsoft
    Learn "Role Based Access Control for Applications in Exchange Online" FAQ
  author:
related: []
proposed_tags: []
---

When an app or managed identity is limited to specific mailboxes with Exchange Online RBAC for Applications, any Microsoft Graph Mail.* application permission it also holds in Entra ID still applies to every mailbox, so the scope quietly stops protecting anything.

## What happened
SetEmailCategory's managed identity needs Mail.ReadWrite on one shared mailbox only. While designing the permission model we checked the RBAC for Applications FAQ on Microsoft Learn: the permissions an app ends up with are the Entra grants plus the Exchange RBAC grants, not one limited by the other. The usual Graph setup step, "add the Mail.ReadWrite application permission and grant admin consent", would therefore have undone the mailbox scope entirely.

## Why it happened
The two systems are evaluated separately and their results are combined. A management scope narrows only the Exchange role assignment it is attached to; it doesn't restrict permissions granted elsewhere.

## What to do instead
- Give the identity **no** Graph mail permission in Entra ID. Grant access only through `New-ManagementScope` + `New-ManagementRoleAssignment -Role "Application Mail.ReadWrite"`.
- Have the grant script read the service principal's `appRoleAssignments` from Graph and refuse to continue if any exist (as `scripts/Grant-MailboxAccess.ps1` does).
- Prove the scope with `Test-ServicePrincipalAuthorization` against the target mailbox *and* a mailbox outside the scope.
- Allow 30 minutes to 2 hours for the assignment to take effect.

## How to recognise it early
In the Entra admin centre, under the enterprise app's Permissions, any Microsoft Graph `Mail.*` application permission listed there means the Exchange scope isn't limiting anything. If `Test-ServicePrincipalAuthorization` shows access to the out-of-scope mailbox, that's the same problem.

## When this does NOT apply
Delegated (signed-in user) permissions are a different model. This lesson hasn't yet been confirmed in a live tenant: it comes from Microsoft's documentation and is enforced by the script.

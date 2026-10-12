---
id: 2026-10-12-2038-verify-volatile-platform-facts-on-microsoft-learn
title: Check volatile Azure and Power Platform facts on Microsoft Learn before relying on them
applies_when: >
  designing or documenting against Azure or Power Platform limits and behaviours (plan
  support, scale minimums, timeouts, retry defaults, permission models) from memory
rule: >
  When a design depends on a platform limit or behaviour, look it up on Microsoft Learn
  (the Learn MCP) before building on it and cite it in the commit or docs, because these
  facts change and several of our from-memory assumptions were wrong in ways that would
  have failed in production.
lesson_type: convention
phase: design
domain: [process, infra]
tech: [azure-functions, power-automate]
scope: this-org
cost_if_ignored: rework
confidence: one-off
status: active
superseded_by:
expires:
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: direct-experience
  evidence: >
    commit 394bbbf (Flex .NET 10 support, RBAC for Applications union); commit afa3f46, PR
    #1 (Flex 40-instance guidance, Power Automate retry defaults and 120 s limit); commit
    3963453, PR #5 (trigger concurrency caveats)
  author:
related: [2026-10-12-2038-exchange-rbac-for-apps-adds-to-entra-graph-grants, 2026-10-12-2038-flex-consumption-http-max-instances-below-40, 2026-10-12-2038-power-automate-retries-every-5xx, 2026-10-12-2038-trigger-concurrency-control-on-mailbox-flows]
proposed_tags: []
---

When designing or documenting against Azure or Power Platform limits and behaviours, checking each one on Microsoft Learn first catches out-of-date or wrong assumptions before they're built into templates and runbooks.

## What happened
In the SetEmailCategory session, the Microsoft Learn MCP was used before writing infrastructure and again during each review round. Lookups confirmed that Flex Consumption supports .NET 10 (`'10.0'`) and that Exchange RBAC for Applications adds to Entra grants. They also overturned three things we'd written from memory:
- the 2-instance cap (Flex says HTTP apps need at least 40);
- "500 avoids retries" (Power Automate retries every 5xx);
- our runbook advice to turn on trigger concurrency control (it can't be undone and can drop trigger events).

## Why it happened
Platform limits change over time, and remembered "facts" are often half right. Each wrong assumption sounded reasonable enough that nothing prompted a check until a review specifically looked for one.

## What to do instead
- Before writing Bicep or runbook steps that depend on a limit, look it up with `microsoft_docs_search`, then `microsoft_docs_fetch` the page if the snippet is ambiguous.
- Note the source in the commit message, Bicep parameter description or runbook, so the next reader can check it again.
- Clearly label anything Learn doesn't confirm as unverified (as the journal does for `WEBSITE_AUTH_ENABLED` on Flex), and have a deployment smoke test check it where possible.

## When this does NOT apply
Stable language or library behaviour that the test suite already proves.

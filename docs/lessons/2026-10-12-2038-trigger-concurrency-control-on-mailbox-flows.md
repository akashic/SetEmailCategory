---
id: 2026-10-12-2038-trigger-concurrency-control-on-mailbox-flows
title: Don't use trigger concurrency control to throttle a flow that must handle every email
applies_when: >
  a Power Automate flow triggered by email arriving in a mailbox is causing bursts against
  a downstream API, and someone suggests turning on the trigger's concurrency control to
  throttle it
rule: >
  When a mailbox-triggered flow must process every email, leave trigger concurrency
  control off and absorb bursts in the called service, because the setting can only be
  removed by deleting and re-adding the trigger, and once its waiting-run queue is full,
  new trigger events may never become runs.
lesson_type: anti-pattern
phase: operation
domain: [integration, reliability]
tech: [power-automate]
scope: this-stack
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
    commit 3963453 (PR #5), which rewrites runbook Phase 7 step 5; the earlier advice is
    in commit afa3f46; Microsoft Learn "Limits of automated, scheduled, and instant flows"
    (concurrency and waiting-run limits)
  author:
related: [2026-10-12-2038-per-instance-concurrency-gate-multiplies-on-scale-out]
proposed_tags: []
---

When a Power Automate flow triggered by email arriving in a mailbox creates bursts against a downstream service, turning on the trigger's concurrency control looks like an easy throttle, but it can't be undone in place and can stop some emails from ever producing a run.

## What happened
Our runbook originally said that if bursts caused 429 or `ResponseTimeout` errors, you should enable *Settings → Concurrency control* on the trigger with a degree of parallelism of about 10. While addressing the round-3 review we checked Microsoft Learn and withdrew that advice:
- The setting can only be turned off by deleting and re-adding the trigger.
- Waiting runs are capped at 10 plus the degree of parallelism. Microsoft's guidance is "to ensure all triggers result in flow runs, leave the Concurrency Control setting off".

## Why it happened
Concurrency control queues runs in Power Automate rather than in the service being called, and that queue is small and bounded. For a mailbox trigger, an email that misses the queue simply never gets processed.

## What to do instead
- Absorb bursts in the called service: high HTTP per-instance concurrency, an in-process gate, honour `Retry-After`, and a deadline under the 120 s synchronous limit.
- Give the action an explicit retry policy so 503s from the service are retried.
- Treat trigger concurrency as a last resort, only when telemetry shows persistent throttling, and test it on a copy of the flow first.

## When this does NOT apply
Flows where some lost runs are acceptable, or where strict ordering matters more than completeness (degree of parallelism 1 is the only way to run a flow sequentially).

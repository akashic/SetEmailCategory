---
id: 2026-10-12-2038-per-instance-concurrency-gate-multiplies-on-scale-out
title: An in-process concurrency gate only limits one instance; scale-out multiplies it
applies_when: >
  protecting a per-resource concurrency limit (such as Graph's 4 concurrent requests per
  mailbox) with an in-process semaphore in a function app that can scale out
rule: >
  When an in-process gate protects a downstream concurrency limit, set HTTP per-instance
  concurrency high (we use 50) so bursts stay on one instance, honour the downstream 429
  Retry-After for the overflow, and document the limit as per-instance, because N
  instances send up to N times the gate.
lesson_type: pitfall
phase: design
domain: [scaling, integration]
tech: [azure-functions, microsoft-graph]
scope: this-stack
cost_if_ignored: rework
confidence: one-off
status: active
superseded_by:
expires:
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: pr-review
  evidence: >
    commit 3963453 (PR #5); docs/github-copilot-review/2026-10-12 17-24 review.md (finding
    4)
  author:
related: [2026-10-12-2038-flex-consumption-http-max-instances-below-40, 2026-10-12-2038-trigger-concurrency-control-on-mailbox-flows]
proposed_tags: []
---

When an in-process semaphore protects a downstream per-resource concurrency limit, such as Microsoft Graph's 4 concurrent requests per app per mailbox, each instance of the function enforces it separately, so scaling out to N instances allows up to 4N requests at once and invites throttling.

## What happened
SetEmailCategory gates Graph calls with a `SemaphoreSlim(4)` handler. Our docs said the per-mailbox limit "is enforced in code". A Copilot review pointed out that Flex can scale to many instances, each with its own gate. Capping instances wasn't an option (see the 40-instance lesson), and a shared limiter (blob lease or Redis) would add infrastructure and a new way to fail.

## Why it happened
A semaphore is per process. Flex adds instances whenever in-flight HTTP requests exceed the per-instance HTTP concurrency, which was 16.

## What to do instead
- Raise `httpPerInstanceConcurrency` (we went from 16 to 50). Flex only scales out above that, so a typical burst shares one instance and one gate. The work is I/O-bound, so a 512 MB instance copes, and queued calls wait seconds, well inside the 90 s deadline.
- Honour Graph's 429 + `Retry-After` for whatever overflows. Overshooting then costs time, not errors.
- Describe the limit as **per instance** everywhere (Bicep parameter descriptions, README, runbook, options comments).
- Watch for scale-out: the runbook's KQL query counts `dcount(cloud_RoleInstance)` per 5 minutes alongside retry events.

## How to recognise it early
More than one instance in a 5-minute bin during a burst, together with Graph retries that show a 429 result.

## When this does NOT apply
If the downstream limit is a hard failure (no retry signal) or overshooting has real costs, you need a distributed limiter instead.

---
id: 2026-10-12-2038-power-automate-120s-sync-limit-needs-a-deadline
title: Finish within Power Automate's 120 s limit, or it retries while the first call still runs
applies_when: >
  an API called synchronously from Power Automate retries a downstream service internally,
  so its worst-case run time can exceed 120 seconds
rule: >
  When an API is called synchronously from Power Automate, enforce an overall deadline
  under 120 s (we use 90 s) and return a retryable 503 when it expires, because otherwise
  Power Automate times out and retries while the first invocation is still working, and
  the duplicates compete for the same downstream capacity.
lesson_type: pitfall
phase: design
domain: [reliability, integration]
tech: [power-automate, azure-functions]
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
    commit afa3f46 (PR #1): ProcessingOptions.DeadlineSeconds and the linked
    CancellationTokenSource in SetCategoryFunction.cs
  author:
related: [2026-10-12-2038-power-automate-retries-every-5xx]
proposed_tags: []
---

When an API called synchronously from Power Automate retries its own downstream calls, its worst case can run past Power Automate's 120-second timeout for synchronous requests; the flow then times out and retries while the original invocation is still running.

## What happened
In SetEmailCategory, each Graph call had a 60-second budget including retries, and one request could make up to 7 Graph calls in sequence (lookup, then GET and PATCH up to three times on conflict). That's a worst case of about 7 minutes. The round-2 self-review checked the 120 s limit on Microsoft Learn: Power Automate would time out, retry, and run duplicate invocations alongside the first, each competing for Graph's 4 concurrent requests per mailbox.

## Why it happened
The resilience settings were chosen for each Graph call on its own, without adding up the worst case of the whole request against the caller's timeout.

## What to do instead
- Put an overall deadline on each invocation, set below 120 s, using a linked `CancellationTokenSource` (`DeadlineSeconds`, default 90, allowed 10–110).
- When it expires, return 503 "Timed out" with ProblemDetails, so Power Automate's retry policy handles it cleanly.
- Make the operation idempotent so those retries are harmless.

## How to recognise it early
`ResponseTimeout` / 504 in flow run history, or function requests that keep running after the flow has already given up on them.

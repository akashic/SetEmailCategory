---
id: 2026-10-12-2038-flex-consumption-http-max-instances-below-40
title: Capping Flex Consumption HTTP apps below 40 instances rejects bursts at the platform
applies_when: >
  setting maximumInstanceCount on an Azure Functions Flex Consumption app with HTTP
  triggers, especially to protect a rate-limited downstream API
rule: >
  When configuring an HTTP-triggered Flex Consumption app, keep maximumInstanceCount at 40
  or more and protect downstream limits in code (concurrency gate, retries), because a low
  instance cap makes the platform reject excess requests before your code runs.
lesson_type: pitfall
phase: design
domain: [scaling, reliability]
tech: [azure-functions, bicep]
scope: this-stack
cost_if_ignored: outage
confidence: one-off
status: active
superseded_by:
expires:
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: direct-experience
  evidence: >
    commit afa3f46 (PR #1); infra/main.bicep @minValue(40) on maximumInstanceCount
  author:
related: [2026-10-12-2038-per-instance-concurrency-gate-multiplies-on-scale-out, 2026-10-12-2038-review-against-the-real-caller]
proposed_tags: []
---

When an HTTP-triggered Azure Functions app on the Flex Consumption plan has its maximum instance count set below 40, bursts beyond that capacity are rejected by the platform before they reach the function, which looks like random request failures to callers.

## What happened
The first SetEmailCategory template capped the app at 2 instances × 2 concurrent requests, to stay under Microsoft Graph's limit of 4 concurrent requests per mailbox. A review focused on the real caller (a flow triggered by email arriving in the mailbox) asked what 30 emails arriving together would do, and the Flex documentation on Microsoft Learn answered: max instance counts below 40 "can cause frequent request failures" for HTTP apps. Most of the burst would have failed before reaching our code.

## Why it happened
We used the scale settings to enforce a downstream API's concurrency limit. Flex's own capacity limit is enforced at the front door; when that's full it rejects the request rather than holding it until an instance frees up.

## What to do instead
- Keep `maximumInstanceCount` ≥ 40 (the template now enforces it with `@minValue(40)`).
- Enforce the downstream limit inside the app: a process-wide `SemaphoreSlim` handler around the Graph `HttpClient`, plus retries that honour `Retry-After`.
- See the related lesson on why an in-process gate alone isn't enough when the app scales out.

## How to recognise it early
Any parameter or review comment that uses instance count to protect a downstream API. Platform 429s or 503s in caller history that never appear in the function's own request logs.

## When this does NOT apply
Non-HTTP triggers (queues, timers) don't have this front-door rejection; there, limiting instances is a valid way to throttle.

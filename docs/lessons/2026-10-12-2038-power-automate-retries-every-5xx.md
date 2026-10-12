---
id: 2026-10-12-2038-power-automate-retries-every-5xx
title: Power Automate retries every 5xx from a custom connector, including 500
applies_when: >
  choosing HTTP status codes for an API called through a Power Automate custom connector,
  especially for errors that shouldn't be retried
rule: >
  When an API is called from Power Automate, return 4xx for anything a retry can't fix and
  5xx only when a retry might succeed, and set an explicit retry policy on the action,
  because the default policy retries 408, 429 and every 5xx, and how often depends on the
  licence's performance profile.
lesson_type: pitfall
phase: design
domain: [api, integration]
tech: [power-automate, power-platform-custom-connectors]
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
    commit afa3f46 (PR #1), which corrects the comment in SetCategoryFunction.cs and the
    README status table
  author:
related: [2026-10-12-2038-power-automate-120s-sync-limit-needs-a-deadline]
proposed_tags: []
---

When an API is called through a Power Automate custom connector, the action's default retry policy retries every 5xx response (and 408 and 429), so returning 500 doesn't stop retries, and a permanent error returned as 5xx gets retried for about an hour.

## What happened
In round 1, SetEmailCategory's fail-closed check (App Service Authentication disabled) returned 500, with a comment saying 500 was chosen "so retry policies don't hammer it". The round-2 self-review checked Power Automate's documented defaults: 12 retries over about an hour on the Medium/High performance profiles, and only 2 on Low. Both the comment and the README were wrong. We also found that permanent Graph 4xx errors were being returned as 503, so they were retried for an hour for nothing.

## Why it happened
We assumed 500 meant "server bug, don't retry". Power Automate treats every 5xx as possibly transient.

## What to do instead
- Use 4xx (400, 404, 409, 413) for errors where retrying is pointless; Power Automate doesn't retry them.
- Use 5xx deliberately when a retry may help: we use 502 for the up-to-2-hour Exchange permission propagation delay and 503 for throttling or timeouts.
- Set the action's retry policy explicitly (we document Exponential, count 6, PT20S, max PT10M), so behaviour doesn't depend on which licence the flow runs under.

## How to recognise it early
Flow run history showing the same action retried many times against an error that will never change.

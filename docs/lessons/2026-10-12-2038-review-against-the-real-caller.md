---
id: 2026-10-12-2038-review-against-the-real-caller
title: Review against the real caller (polling trigger + connector), not just the code
applies_when: >
  reviewing a service before first deployment when it is called by a specific platform,
  such as a Power Automate flow triggered by email arriving in a mailbox through a custom
  connector
rule: >
  When reviewing a service before deployment, walk through its real caller's behaviour
  (timeouts, retry policy, trigger timing, burst patterns, connection identity) and check
  those limits on Microsoft Learn, because a generic code review misses the failures that
  only show up at that boundary.
lesson_type: heuristic
phase: testing
domain: [process, reliability]
tech: [power-automate, azure-functions]
scope: this-org
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
    PR #1: commit cf963f1 (generic external review, round 1) vs commit afa3f46 (self-
    review against the real caller, round 2); docs/journal/2026-10-12 20-32 journal.md
  author:
related: [2026-10-12-2038-flex-consumption-http-max-instances-below-40, 2026-10-12-2038-power-automate-120s-sync-limit-needs-a-deadline, 2026-10-12-2038-outlook-message-id-changes-when-moved, 2026-10-12-2038-power-automate-retries-every-5xx]
proposed_tags: []
---

When a service is about to be deployed behind a specific caller, such as a Power Automate flow triggered by email arriving in a shared mailbox and calling through a custom connector, reviewing it against that caller's behaviour finds the problems that matter in production; a generic code review mostly doesn't.

## What happened
SetEmailCategory had two review rounds before deployment. Round 1 was a generic external review: it led to useful fixes (an empty PATCH body mistaken for a 412, failing closed if Easy Auth is off), but several of its points were wrong or didn't apply. Round 2 was an aggressive self-review framed as "a polling shared-mailbox trigger calling through a custom connector". It found several issues round 1 had missed, including:
- the 2-instance cap that would make the platform reject bursts;
- a worst case of about 7 minutes against Power Automate's 120 s limit;
- message IDs changing when a message is moved;
- 5xx statuses chosen on a wrong assumption about retries;
- the risk of the flow's connection breaking when its owner's account changes.

## What to do instead
Before deploying, go through the caller's behaviour with these questions:
- **Timing:** what's the caller's timeout, and what's our worst case including retries?
- **Retries:** what does it retry by default (which statuses, how many times, on which licence tier)?
- **Trigger:** how does the trigger fire (polling delay, what can change in between)?
- **Bursts:** what happens when 30 events arrive at once?
- **Identity:** whose identity does the connection use, and what breaks it?

Check each answer on Microsoft Learn rather than from memory.

## When this does NOT apply
Internal libraries with no single dominant caller. There, a generic review is the right tool.

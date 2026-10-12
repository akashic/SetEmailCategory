---
id: 2026-10-12-2038-outlook-message-id-changes-when-moved
title: Outlook message IDs change when a message is moved; pass internetMessageId as well
applies_when: >
  a flow triggered by email arriving in a mailbox (a polling trigger) passes the trigger's
  Message Id to an API that later reads or updates that message through Graph
rule: >
  When a mailbox-triggered flow hands a message to another service, pass both the
  trigger's Message Id and its Internet Message Id, and fall back to a $filter on
  internetMessageId when the ID gives 404 or an invalid-ID error, because moving a message
  to another folder changes its ID and the polling trigger can fire after a move.
lesson_type: pitfall
phase: design
domain: [integration, api]
tech: [microsoft-graph, power-automate, exchange-online]
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
    commit afa3f46 (PR #1): MailCategoryService internetMessageId fallback; runbook Phase
    7 step 2
  author:
related: []
proposed_tags: []
---

When a flow triggered by email arriving in a shared mailbox passes the trigger's Message Id on for later Graph calls, the ID can already be stale, because Outlook IDs change when a message moves folders and the trigger polls, sometimes minutes after delivery.

## What happened
SetEmailCategory first used only `messageId` and ignored `internetMessageId` whenever `messageId` was present. The round-2 self-review, focused on the real caller, noted that a person or an inbox rule can move a message between delivery and the polling trigger firing; the call would then fail with 404 even though the message still existed. We haven't seen this in production yet; it was caught before deployment.

## Why it happened
The default Graph/Outlook message ID depends on the folder the message is in. `internetMessageId` (the RFC 2822 Message-ID header) stays the same when a message moves.

## What to do instead
- In the flow, map **both** *Message Id* and *Internet Message Id* from the trigger (the connector marks both fields as important).
- In the service, try the ID first. On 404 or an invalid-ID code (`ErrorInvalidIdMalformed`, `ErrorInvalidId`, `ErrorInvalidMailboxItemId`), look the message up with `$filter=internetMessageId eq '<...>'&$top=2`.
- Add the angle brackets if they're missing (Graph stores `<id@host>` and the filter needs an exact match), and escape single quotes by doubling them.
- Return 409 when the lookup finds more than one message (e.g. a copy in Sent Items and the Inbox).

## When this does NOT apply
Calls that are made immediately after the service itself has read the message, with no chance for it to move in between.

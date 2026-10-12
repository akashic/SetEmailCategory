---
id: 2026-10-12-2038-homebrew-azure-functions-tap-needs-trust
title: Homebrew 7 needs both Azure Functions Core Tools formulas trusted, then linked
applies_when: >
  installing Azure Functions Core Tools (func) on macOS with Homebrew 7 from the
  azure/functions tap
rule: >
  When installing func with Homebrew 7, trust both azure-functions-core-tools@4 and azure-
  functions-core-tools formulas (not the whole tap), then brew link, because the tap is
  untrusted by default and one formula depends on the other.
lesson_type: workaround
phase: implementation
domain: [tooling]
tech: [homebrew, azure-functions]
scope: this-stack
cost_if_ignored: minor
confidence: one-off
status: active
superseded_by:
expires: 2027-04-12
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: direct-experience
  evidence: >
    docs/journal/2026-10-12 20-32 journal.md, section "15:00: Tooling"
  author:
related: [2026-10-12-2038-homebrew-powershell-cask-is-stale]
proposed_tags: []
---

When installing Azure Functions Core Tools (`func`) with Homebrew 7 from the `azure/functions` tap, the install is blocked because third-party taps are untrusted by default, and trusting only the versioned formula isn't enough.

## What happened
Setting up this machine for SetEmailCategory, the `func` install failed on trust. Trusting `azure-functions-core-tools@4` alone still failed, because it depends on the unversioned `azure-functions-core-tools` formula. After trusting both, the binary still needed `brew link`. Result: `func` 4.15.2.

## Why it happened
Homebrew 7 requires taps outside Homebrew's own to be explicitly trusted. Trust applies to each formula, so a dependency also needs it.

## What to do instead
```
brew trust --formula azure/functions/azure-functions-core-tools@4
brew trust --formula azure/functions/azure-functions-core-tools
brew install azure/functions/azure-functions-core-tools@4
brew link azure-functions-core-tools@4
```
Trust individual formulas rather than the whole tap, to keep the trusted set small.

## When this does NOT apply
Windows (winget/MSI) and Linux (apt) installs, or once Microsoft publishes Core Tools somewhere Homebrew trusts by default. Check again by the expiry date.

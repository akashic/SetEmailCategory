---
id: 2026-10-12-2038-homebrew-powershell-cask-is-stale
title: The Homebrew PowerShell cask is stale (7.1.3 x86_64); use the formula on Apple silicon
applies_when: >
  installing or upgrading PowerShell 7 (pwsh) on an Apple silicon Mac with Homebrew, or
  when pwsh fails with "bad CPU type"
rule: >
  When pwsh fails on an Apple silicon Mac or brew install --cask powershell says it is up
  to date, install the powershell formula (brew install powershell) instead, and check
  which dotnet is first on your PATH afterwards, because the old cask is a stale x86_64
  7.1.3 build and the formula pulls in its own .NET SDK.
lesson_type: pitfall
phase: implementation
domain: [tooling]
tech: [homebrew, powershell, dotnet]
scope: this-stack
cost_if_ignored: minor
confidence: one-off
status: active
superseded_by:
expires:
provenance:
  projects: [set-email-category]
  date: 2026-10-12
  source: direct-experience
  evidence: >
    docs/journal/2026-10-12 20-32 journal.md, section "15:31: First commit, push and
    merge" (PowerShell fix)
  author:
related: [2026-10-12-2038-homebrew-azure-functions-tap-needs-trust]
proposed_tags: []
---

When PowerShell was installed on an Apple silicon Mac through the old Homebrew cask, `pwsh` can be an x86_64 7.1.3 build that fails with "bad CPU type" without Rosetta, and `brew install --cask powershell` reports it as already up to date.

## What happened
While writing the SetEmailCategory admin scripts, `pwsh` failed with "bad CPU type". `brew install --cask powershell` did nothing because Homebrew considered 7.1.3 (from 2021, in `/usr/local`) current. PowerShell is now distributed as a Homebrew **formula**: `brew install powershell` installed a native 7.6.6. That also installed Homebrew's .NET 10.0.401 SDK, which now comes before the original .NET install on the PATH. We re-ran the tests to confirm nothing changed. Uninstalling the old cask needs `sudo`, so it has to be run interactively.

## What to do instead
- `brew install powershell` (the formula), then `pwsh --version`.
- Run `which -a dotnet` and `dotnet --list-sdks` to see which SDK is now first. A `global.json` pinning the major version helps keep builds consistent.
- Run `brew uninstall --cask powershell` yourself (needs sudo) to remove the stale build.
- If you only need to parse-check or lint scripts, `dotnet tool install PowerShell` into a scratch folder avoids changing the system.

## How to recognise it early
"bad CPU type in executable", or `pwsh` reporting 7.1.x.

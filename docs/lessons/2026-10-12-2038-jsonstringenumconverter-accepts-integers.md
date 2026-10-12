---
id: 2026-10-12-2038-jsonstringenumconverter-accepts-integers
title: System.Text.Json string enum converter accepts integers, letting undefined values through
applies_when: >
  an API request model uses JsonStringEnumConverter (or JsonStringEnumConverter<T>) for an
  enum field and the code switches on that enum
rule: >
  When a request enum must be one of its names, use a converter with allowIntegerValues:
  false, also check Enum.IsDefined in validation, and give the switch a throwing default,
  because the default converter turns "mode": 99 into an undefined value that falls
  through every case.
lesson_type: pitfall
phase: implementation
domain: [api]
tech: [dotnet, system-text-json]
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
    1); StrictStringEnumConverter in Models/SetCategoryRequest.cs
  author:
related: []
proposed_tags: []
---

When an API's request model uses System.Text.Json's string enum converter, integer values are accepted by default, so a body like `"mode": 99` deserialises to an undefined enum value and slips past code that only handles the named cases.

## What happened
SetEmailCategory's `CategoryMode` (add, replace, remove) used `JsonStringEnumConverter<CategoryMode>`. `"mode": 99` passed validation; `Merge` had no default case and returned the existing categories, so the API answered `200 changed:false`, a misleading success. The connector's swagger only offers the three names, but "Enter custom value" in the flow designer, or raw JSON, gets around that.

## Why it happened
`allowIntegerValues` defaults to true. Comma-separated strings (`"replace, remove"`) can also combine values into an undefined number.

## What to do instead
- Subclass the converter: `class StrictStringEnumConverter<T>() : JsonStringEnumConverter<T>(null, allowIntegerValues: false)`. This rejects `99`, `1` and `"1"` when the JSON is parsed.
- Also check `Enum.IsDefined(mode)` in the validator, which catches comma-joined values and callers that skip JSON.
- Add `default: throw new ArgumentOutOfRangeException(...)` to switches over request enums.
- Test with `1` and `"1"` as well as `99`. `1` is a *defined* value, so only the converter catches it (confirmed by restoring the old converter, which made those tests fail).

## When this does NOT apply
APIs that deliberately accept numeric enum values for backward compatibility.

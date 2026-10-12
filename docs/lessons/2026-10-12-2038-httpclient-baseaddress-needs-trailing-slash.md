---
id: 2026-10-12-2038-httpclient-baseaddress-needs-trailing-slash
title: A configurable Graph base URL without a trailing slash silently drops /v1.0
applies_when: >
  an HttpClient BaseAddress comes from configuration (for example a Graph URL that can be
  overridden for national clouds) and requests use relative paths
rule: >
  When HttpClient.BaseAddress comes from configuration, add the trailing slash in code and
  derive anything tied to the host (such as the token scope) from the same value, because
  "…/v1.0" + "users/x" resolves to "…/users/x" and a separately configured scope can
  disagree with the URL.
lesson_type: pitfall
phase: implementation
domain: [api, integration]
tech: [dotnet, microsoft-graph]
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
    commit 3963453 (PR #5): SharedMailboxOptions.GraphBaseUri / GraphTokenScope;
    tests/GraphCloudOptionsTests.cs
  author:
related: []
proposed_tags: []
---

When an `HttpClient.BaseAddress` comes from configuration and the configured value has no trailing slash, relative request paths replace the last path segment, so `https://graph.microsoft.com/v1.0` + `users/x` quietly becomes `https://graph.microsoft.com/users/x`.

## What happened
A round-3 review flagged that SetEmailCategory requested its token for `https://graph.microsoft.com/.default` while `GraphBaseUrl` could be changed for national clouds. While fixing that, we found the second problem: the default value ended in `/`, but anyone setting the option to `…/v1.0` would lose the version segment. No error is raised; the request just goes to the wrong path.

## Why it happened
Relative URI resolution (RFC 3986) treats the last segment without a slash as a "file" and replaces it. The token scope was hard-coded separately from the URL, so the two could drift apart.

## What to do instead
- Expose a normalised `Uri` (append `/` if it's missing) and use only that for `BaseAddress`.
- Derive the token scope from the same value: `GetLeftPart(UriPartial.Authority) + "/.default"`. For example, `graph.microsoft.us` becomes `https://graph.microsoft.us/.default`.
- Require an absolute https URL at startup (`IValidatableObject` with `ValidateOnStart`).
- Test through the real DI pipeline that both the scope requested and the request path come out right.

## How to recognise it early
404 or 400 errors from Graph after changing the base URL setting, with paths missing `/v1.0/`.

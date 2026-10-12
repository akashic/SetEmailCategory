---
id: 2026-10-12-2038-gh-token-needs-workflow-scope-to-push-workflows
title: Pushing .github/workflows changes fails without the gh token's workflow scope
applies_when: >
  pushing a commit that adds or changes files under .github/workflows/ using credentials
  from the gh CLI
rule: >
  When a push includes .github/workflows/ changes and fails with a workflow-scope
  rejection, run gh auth refresh -h github.com -s workflow and push again, because GitHub
  requires that OAuth scope for workflow files and the default gh login may not include
  it.
lesson_type: pitfall
phase: deployment
domain: [ci, source-control]
tech: [gh-cli, github-actions, git]
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
    merge" (first push of commit 394bbbf rejected)
  author:
related: []
proposed_tags: []
---

When a push includes changes under `.github/workflows/` and git is using credentials from the gh CLI, GitHub rejects the whole push unless the token has the `workflow` OAuth scope.

## What happened
The first push of SetEmailCategory (commit `394bbbf`, which added `.github/workflows/deploy.yml`) was rejected even though gh was signed in and other pushes worked. The user ran `gh auth refresh -h github.com -s workflow`, and the next push succeeded.

## Why it happened
GitHub requires a separate OAuth scope to create or change workflow files, because they can run code with the repository's secrets. The gh token on this machine had been issued without it.

## What to do instead
- Run `gh auth refresh -h github.com -s workflow` (it's interactive, so in Claude Code have the user run it with the `!` prefix), then push again.
- Check ahead of time with `gh auth status`, which lists the token's scopes.

## How to recognise it early
A rejection message that mentions the `workflow` scope, on a push whose diff touches `.github/workflows/`.

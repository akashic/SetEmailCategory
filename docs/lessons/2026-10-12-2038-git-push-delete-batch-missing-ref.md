---
id: 2026-10-12-2038-git-push-delete-batch-missing-ref
title: A batched git push --delete with one missing branch can leave the others undeleted
applies_when: >
  deleting several remote branches in one git push origin --delete command when the local
  remote-tracking refs may be stale
rule: >
  When deleting several remote branches, run git fetch --prune first and delete them one
  at a time (or check git branch -a afterwards), because if one branch is already gone the
  push reports failure and another branch in the same command was left undeleted.
lesson_type: pitfall
phase: operation
domain: [source-control]
tech: [git]
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
    docs/journal/2026-10-12 20-32 journal.md, section "17:50: Round 3 merged and branches
    tidied" (commit e6c31c9)
  author:
related: []
proposed_tags: []
---

When several remote branches are deleted with one `git push origin --delete a b` and one of them no longer exists on the remote, the push reports failure and the other branch can be left in place, even though its deletion printed no error.

## What happened
After merging PR #5 in SetEmailCategory, we ran `git push origin --delete fix/review-feedback-2 copilot/review-this-repo`. The Copilot branch had already been deleted on GitHub, but the local tracking ref was stale, so git printed "unable to delete 'copilot/review-this-repo': remote ref does not exist" and "failed to push some refs". After `git fetch --prune`, `remotes/origin/fix/review-feedback-2` was still listed. Deleting it on its own worked.

## Why it happened
Not confirmed. What we saw is consistent with git rejecting the whole push before sending it once one ref is invalid, rather than deleting the valid branches and failing only the missing one.

## What to do instead
- Run `git fetch --prune` first, so local refs match the remote.
- Delete branches one per command, or run `git branch -a` afterwards to check each is gone.
- Check each branch is fully merged first with `git log main..origin/<branch>` (empty means safe to delete).

## How to recognise it early
"failed to push some refs" from a delete command that named more than one branch.

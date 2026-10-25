# Syncing Your Repo Copy with the Original Repo

How to pull updates from the original GitHub repo into your copy without losing the edits you've made.

The approach: add the original repo as a second remote (`upstream`), fetch its changes, and merge them into your copy. Git keeps your edits and only asks you to decide where both sides changed the same lines.

> **Shortcut:** [`tools/Sync-FromUpstream.ps1`](tools/Sync-FromUpstream.ps1) does steps 1–3 and 5 for you (PowerShell 7). Run it from a clone of your copy: `./tools/Sync-FromUpstream.ps1`, adding `-AllowUnrelatedHistories` if your copy isn't a fork. It stops on conflicts so you can resolve them as in step 4.

---

## 1. Make a safety branch first

```bash
cd your-repo
git checkout main
git pull
git branch backup-before-upstream-merge
```

If anything goes wrong, you can always get back to exactly where you were.

## 2. Add the original repo as `upstream` and fetch it

```bash
git remote add upstream https://github.com/ORIGINAL-OWNER/ORIGINAL-REPO.git
git fetch upstream
```

Check with `git remote -v`. You should see both:

- `origin`: your copy
- `upstream`: the original

## 3. Merge the original's changes into yours

```bash
git merge upstream/main
```

> Use `upstream/master` if that's the original repo's default branch name.

## 4. Resolve any conflicts

If both you and the original changed the same lines, Git stops and marks those files. Run `git status` to list them. In each file you'll see blocks like:

```
<<<<<<< HEAD
your version
=======
their version
>>>>>>> upstream/main
```

For each block:

1. Edit it to what you want to keep (yours, theirs, or a combination).
2. Delete the `<<<<<<<`, `=======` and `>>>>>>>` marker lines.

Then stage and commit:

```bash
git add <file>
git commit
```

**Tip:** VS Code shows *Accept Current / Accept Incoming / Accept Both* buttons above each conflict, which makes this much easier.

## 5. Push the result to your repo

```bash
git push origin main
```

---

## Special cases

### Your copy is a real GitHub fork

If the repo page says "forked from ..." under the name, you can also use the **Sync fork** button on GitHub. It works when there are no conflicts; the command-line route above gives more control when there are.

### Your copy is not a fork

If the copy was made by downloading files or with "Use this template", the two repos don't share history and step 3 will refuse to run. Use:

```bash
git merge upstream/main --allow-unrelated-histories
```

Expect many more conflicts, because Git can't tell what you changed versus what was there originally. To back out of a messy merge:

```bash
git merge --abort
```

---

## Future updates

Once `upstream` is set up, syncing again is just:

```bash
git fetch upstream
git merge upstream/main
git push origin main
```

## Quick reference

| Task | Command |
|---|---|
| Create backup branch | `git branch backup-before-upstream-merge` |
| Add original as remote | `git remote add upstream <url>` |
| Check remotes | `git remote -v` |
| Get original's changes | `git fetch upstream` |
| Merge them in | `git merge upstream/main` |
| See conflicted files | `git status` |
| Abort a merge | `git merge --abort` |
| Restore from backup | `git reset --hard backup-before-upstream-merge` |

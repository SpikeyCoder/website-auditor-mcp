# Notes for Claude Code sessions

## Review every PR to convergence, then run /security-review

One review round is not a review. Fixes are written with less scrutiny than
the change they fix, and later rounds keep finding defects in them.

- Open every PR as a draft, and keep it a draft until the steps below are
  done.
- Run `/code-review` on every PR without asking first, and again after every
  round of fixes.
- Repeat until a round comes back with no findings. That clean round is
  convergence; anything short of it is not done.
- A finding judged not worth fixing still counts. Record why in the PR so the
  next round doesn't raise it again, then re-run.
- Then run `/security-review` on the converged head. If it leads to fixes,
  run `/code-review` again until it converges, since the fix is new code.
- Don't mark a PR ready for review, or hand it over as finished, until both
  are done. In the PR, say how many review rounds it took and what each one
  found.

All of the above is subject to the next section, which wins where they
differ.

### This repo is public: review before anything is pushed

Anyone can read everything this repo publishes, drafts, diffs and
force-pushed history included. A weakness that is pushed, described or
located there tells the world where the hosted service is weak.

- A security finding is anything an attacker could use, whichever review
  raised it and whatever it is called: a missing auth or ownership check,
  unescaped output, an unbounded fetch, an exposed secret.
- Review locally, before any push. Run `/code-review` rounds on the
  unpushed branch until one is clean, then `/security-review`, and fix and
  re-review until both are clean. Fold each fix into the unpushed commits
  (amend or squash) so that no commit you push holds the version before the
  fix; the reviews read the branch's net diff and won't see an earlier
  commit. Only then push and open the draft PR. Do the same before every
  later push. Never run either review with `--comment` or `--post`.
- Never describe or locate a security finding anywhere public: a branch
  name, commit message, PR title or description, review comment, issue, or
  code comment. The PR's round record leaves security findings out, and
  about `/security-review` it says only that it ran.
- Stop and tell the user in the session, not on GitHub, if a security
  finding is in code that has already been pushed anywhere, including this
  PR's own branch, or if a secret has been exposed. A secret counts as
  exposed once it has been committed at all, locally included. Don't fix
  it publicly, don't force-push over it, and don't try to close it
  yourself: the user decides how it's fixed and disclosed, and an exposed
  secret has to be revoked or rotated, which removing it doesn't do. Until
  the user says otherwise, the PR stays a draft.

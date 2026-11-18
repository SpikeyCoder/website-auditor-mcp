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
  are done. In the PR, say how many review rounds it took, what each one
  found, and what `/security-review` found.

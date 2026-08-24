# v1.0.20 — cited sources

## Features

**`get_ai_visibility` now returns `sources`** — the ranked list of documents
the AI assistants actually read while answering (chaos_tester #447): top ten,
deduplicated by domain, ordered by cross-engine agreement then answer count.
Each row carries `domain`, `answers`, `platforms`, `ownership`
(`yours` / `competitor` / `third_party` — competitor rows are context, not
placement targets), and one representative `url`/`title` (`url: null` with an
empty title when no citation named a directly linkable page).

The upstream tri-state is preserved end to end: an array is the evidence,
`sources: null` means the recorded answers cited nothing attributable, and an
**absent** key means the audit holds no readable citation records — absent is
"never measured", never "cited nothing". A payload whose rows are all
malformed reads as absent rather than as an empty list, and the documented
top-ten cap is enforced client-side too.

**The sample audit shows the full evidence shape.** `get_sample_audit` now
carries `sources` plus the backing `all_results[].citations` rows — the exact
payload a real audit returns, on fictional domains — so a keyless evaluator
sees what they would buy, citations included.

## Fixes

- `run_audit`'s description now says where the citation evidence lives
  (`get_ai_visibility`) instead of silently omitting it.
- The Desktop-directory listing (manifest.json) carries the `sources`
  semantics, with a linkage test so the two description surfaces cannot
  drift again.

No breaking changes. 478 tests; typecheck clean.

# Debatefrog evaluation artifacts

The model evaluator writes one cached debate run per model/question under `debate-runs/`.
Those files contain the structured outputs from the candidate model calls, including
claims, turns, scorecard, final summary, evidence, model snapshots, token counts, costs,
latency, and retry metadata.

To rerun only the scoring/evaluation layer against saved debate outputs, set:

```sh
POLYVISE_EVAL_REUSE_DEBATE_ARTIFACTS=true POLYVISE_EVAL_REQUIRE_DEBATE_ARTIFACTS=true npm run eval:debatefrog-models
```

Leave `POLYVISE_EVAL_REQUIRE_DEBATE_ARTIFACTS` unset if you want missing artifacts to be
generated live and then saved.

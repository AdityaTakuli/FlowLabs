# 0004 — The agent composes reviewed snippets instead of writing code

**Status:** accepted · 2026-09-14

## Context
PRD Section 10 plans an LLM agent. The project runs on a Groq API key with a tight token
budget, and PRD 4.3/10.4 forbids executing LLM-written code. We want the agent to produce
useful, runnable analysis while spending as few tokens as possible.

## Decision
`packages/agent` (`flowlab_agent`) implements goal → plan → script:

1. **Snippet library** — `flowlab_agent/snippets/<category>/<name>.toml`. Each file is a
   reviewed, parameterised code template with typed params, `requires`/`provides` state
   tokens (`df`, `split`, `features_ready`, `model`, `preds`) and an executable example.
2. **Local retrieval** — BM25 with synonyms ranks snippets for the goal. Only the top-k
   one-line *signatures* (id, title, param names/types) go into the prompt. No code, no rows.
3. **LLM output** — JSON only: `{"target", "steps": [{"use", "with"}], "note"}`, via Groq
   JSON mode at temperature 0, ~1k tokens per request.
4. **Deterministic composition** — params are validated (columns against the dataset,
   bounds, choices, safe paths) and rendered as Python literals. Steps are stage-sorted
   (clean → split → prepare → model → evaluate → export); loading, the split, numeric
   preparation, a default model and predictions are inserted when needed. Only real
   ambiguity goes back to the LLM as short error lines (max 2 repairs).
5. **Caching and accounting** — identical requests are served from `.flowlab/llm_cache`;
   token usage is appended to `.flowlab/llm_usage.jsonl`.

## Guarantees (enforced by tests)
- The library lints clean and **every snippet executes** on a fixture dataset.
- A placeholder may only render as a standalone literal (never inside a string), so hostile
  column names or values cannot inject code.
- Learning steps (impute, encode, scale, outlier handling) fit on train only; the split is
  always before them.

## Consequences
The LLM "adjusts" snippets only through validated parameters. New capabilities are added by
writing a snippet (TOML + example), not by prompting. The Flow Spec engine is untouched;
mapping snippet plans to Flow Spec nodes is future work.

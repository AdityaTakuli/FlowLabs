# 0010 — Code segregation analyser and Architecture view

**Status:** accepted · 2026-09-15

## Context
The Code Segregation Bylaws define a two-level architecture (Components and Units) produced from
a compressed symbol graph, never from raw source at scale. Deterministic stages 0–3 and 7 always
produce a complete architecture; stages 4–6 (naming, classification, contracts) are optional and
budgeted.

## Decision
- **Package.** `flowlab_lab.segregation` walks the project, parses with `ast`, builds import/call/
  dataflow graphs, clusters with seeded Louvain (Leiden when `leidenalg` is installed), classifies
  by rules, and emits a versioned manifest. Tests and migrations are parsed for a shadow map, never
  clustered (SEG-022).
- **Model.** Fingerprints only (rung 3): unit names, truncated signatures, first docstring lines,
  imports, edge counts. Hard token ceilings, SHA-256 cache, secret redaction. Invalid model output
  is retried once then discarded (SEG-094). The API requires `confirm_external` consent, same as Ask.
- **Surfaces.** Architecture mode in the canvas (`/api/architecture*`), `flowlab lab architecture`
  on the CLI (writes `.flowlab/architecture/manifest.json`). "Report incorrect segregation" stores
  an anonymised fingerprint locally (SEG-100).
- **Evaluation.** CI scores hand-labelled fixture repos (`flowlab_lab.segregation.eval`) against
  the SEG-098 thresholds. Leakage recall is the metric that matters (SEG-099). A 20-repository
  public benchmark is not in this tree yet.

## Deviations
1. **Leiden.** networkx's `leiden_communities` needs an external backend. Default install uses
   Louvain with a connected-component refinement so no Component is disconnected internally.
2. **Cycles and layer violations** are findings, not run-aborting errors. Shipping a diagram that
   shows the cycle is more useful than falling back to unnamed clusters.
3. **Repos over 100k LOC** are still analysed as one graph. Stage 4 already batches fingerprints
   by directory (SEG-083). Hierarchical per-package analysis (SEG-082) waits until a repo that size
   exists in CI.
4. **Generated names** (`cluster_N`) ship when the model is off. They are unique and not banned
   names; the UI offers "Name with model" afterwards.

## Not yet
The 20-repo labelled corpus, per-package hierarchical analysis above 100k LOC, and prompt-prefix
caching at the Groq provider (the local content-hash cache is in).

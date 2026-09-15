# 0005 — Code Mode (PRD Part II): what is built now, what waits for Part I

**Status:** accepted · 2026-09-15

## Context
`PRD-flowlab2.md` plans Code Mode as Phases 8–11 on top of Part I Phases 0–5. Part I's API,
database and web canvas (Phases 1–2) do not exist yet. Part I's own guidance is to build the
contracts and engine before the UI, because the UI is cheap to build against a solid contract.

## Decision
Build everything that does not require the server or the browser as `packages/lab`
(`flowlab_lab`), driven by the `flowlab lab …` CLI, with the data contracts the API will use.

| PRD area | Status | Where |
|---|---|---|
| Block segmentation (5.2) | built | `blocks.py` |
| Symbol analysis, edges, confidence (5.3–5.6) | built | `symbols.py`, `codegraph.py` |
| Tier B patterns (5.5) | built, 70 rules, cosmetic only | `patterns.py` |
| Kernel mode, env & resource capture (4.1–4.5) | built | `kernel.py`, `resources.py` |
| Staleness, run node/to/from/stale (8.3) | built | `kernel.py` |
| Edge inspection, snapshots, diff (8.1, 8.2, 8.4) | built | `snapshots.py`, `diff.py` |
| Tracebacks → nodes, hidden state, profiling (8.5–8.7) | built (Debug-here = `LabSession.evaluate`) | `kernel.py` |
| Transformations, backups, undo, conflicts (6.1–6.2) | built with libcst | `transforms.py` |
| Repo tracing (7) | built | `tracer.py`, `trace.py` |
| Flow → Code eject (3.1) | built, metrics identical to the engine | `eject.py` |
| Code → Flow per section (3.1) | built, drafts only | `to_flow.py` |
| Privacy, credential masking, Local-only (4.3, 12) | built, tested against a real kernel | `privacy.py` |
| DB rows (10.2) | models only | `models.py`, `kernel.ExecutionRecord` |
| Canvas, linear/split views, Monaco, heat-map (6.3, 9) | **deferred** to Part I Phase 2 | — |
| REST/WS API, attach token, version negotiation (4.2, 11, 13) | **deferred** to Part I Phase 1 | — |
| `pylsp` completion (6.3), "report incorrect graph" (13) | **deferred** | — |

## Deviations and refinements
1. **Corpus.** The 50 public Kaggle notebooks are replaced by a generated 50-notebook corpus
   covering the same constructs (no network or licensing needed in CI). Real notebooks should be
   added before Phase 9's correctness review.
2. **Splitting plain scripts** requires `add_markers` first. Inserting one `# %%` into a
   marker-less file silently re-segments the whole file, which the PRD forbids.
3. **Reordering a marker-less first region** of a `# %%` script inserts a marker so the region
   stays its own block instead of merging into its new neighbour.
4. **Duplicate** is refused for in-place updates (`x += 1`) and loop-carried names, where a
   rename cannot preserve behaviour. Reads inside the first assignment (`df = df.dropna()`) keep
   the original name.
5. **Safety checks** map old blocks to new ones per operation (not by content hash), so merges
   and extracts that legitimately change a block's text are validated correctly.
6. **Notebook writes** keep the file's original JSON indentation; cells outside the edit are
   byte-identical for nbformat-standard files.
7. **Kernel environment.** The kernel is the `python3` kernelspec of the environment running
   FlowLab, so "the project's own environment" means launching `flowlab` from that environment.
8. **Dead kernels** are detected by polling liveness while waiting for replies (under a second),
   instead of waiting for the execution timeout.
9. **Local-only defaults to on.** Summaries still include numeric min/max/mean, as the PRD allows.
10. **Labels** follow PRD 9.3 order: pattern match, then leading comment, then assigned names;
    definition-only blocks are labelled `def name` and never pattern-matched.

## Open questions still for the founder (PRD 17)
Marimo positioning, VS Code extension vs web canvas, a linear-view default for short notebooks,
tracing overhead defaults, `%run` across files, and whether Local-only also disables the agent.

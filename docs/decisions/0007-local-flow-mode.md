# 0007 — Flow Mode canvas on the local server

**Status:** accepted · 2026-09-15

## Context
PRD Part I Phase 2 specifies the Flow canvas against the hosted API (Postgres flows, versions,
runtimes). That API does not exist; decision 0006 put a local server under the web canvas.

## Decision
- **Files, not rows.** A flow is a Flow Spec `.json` file in the project folder, saved in place
  with a hash check (409 `FILE_CHANGED` if edited on disk). No version table; git is the history.
- **Datasets** are tabular files under the root. Bindings resolve as: path relative to the flow's
  folder or root, else a *unique* file stem anywhere in the project (ambiguity is a compile error).
  Paths may never leave the root. Schemas are profiled once per (path, mtime, size).
- **Compile-on-edit** calls the real compiler (350 ms debounce). The response also carries
  best-effort per-node port schemas from `infer_port_schemas`, which drops structurally broken nodes
  and retries, so column pickers work on half-built flows.
- **Runs** use the engine executor on a single worker thread (one run at a time), in
  `.flowlab/runs/<run_id>` with the shared cache in `.flowlab/cache`. RunEvents are forwarded on the
  existing WebSocket as `flow_event`; `flow_run_finished` closes the run.
- **Cancel** is cooperative: `execute_plan(should_cancel=…)` stops between steps and emits
  `run_cancelled`. A node is never killed mid-write, so artifacts and cache entries stay consistent.
- **Node outputs** are read from run artifacts: table/split previews capped at
  `max_preview_rows`, metrics/charts as JSON, models described by their compiled schema. Pickled
  models are never loaded by the server.
- **Connection rules** are mirrored in the client (`flow/model.ts`) so invalid drags are refused
  with a reason before they land; the compiler stays the authority.

## Not yet
Run comparison view, report view, subflows, dataset upload/connectors (files are added to the
folder instead), agent prompt-to-graph panel.

# 0002 — Cache keys chain upstream keys instead of input artifact hashes

**Status:** accepted · 2026-09-14

## Context
PRD 14.1 defines `node_cache_key = sha256(node_type | params | sorted(input_artifact_content_hashes) | runner_version | global_seed)`.
Input artifact hashes are only known after upstream nodes execute, but the plan (and
"mark cached nodes as skippable", PRD 8.1 stage 5) is produced before execution.

## Decision
A node's key uses `"<port><-<upstream cache key>:<upstream port>"` for each input, plus
extra content hashes a node declares via `cache_inputs` — `source.dataset` contributes the
dataset's content hash. Params are the validated model dump, so omitted defaults and
explicit defaults produce the same key.

Because nodes are deterministic (PRD 14.2, enforced by tests), an upstream key determines
the upstream content, so this is equivalent to hashing artifacts. Including the port name
keeps swapped inputs (e.g. `model`/`data`) from colliding. Position, label and node id never
enter the key (tested with property tests).

Artifact content hashes are still recorded per output in `run.json` for lineage and the
reproducibility test. Sinks (`cacheable = False`) always execute.

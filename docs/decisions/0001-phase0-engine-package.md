# 0001 — Compiler and executor live in `packages/engine` during Phase 0

**Status:** accepted · 2026-09-14

## Context
PRD Section 22 places the compiler under `apps/api/app/compiler/`. Phase 0 has no API but
requires a CLI (`flowlab run`) that compiles and executes flows.

## Decision
The compiler, local executor, dataset resolution and CLI live in `packages/engine`
(`flowlab_engine`). In Phase 1 the FastAPI app imports `flowlab_engine.compiler`.

The PRD 4.2 boundary still holds: semantic/leakage rules are in
`flowlab_engine/compiler/semantic.py`, which is server-side code. `flowlab_nodes` — the
package that ships to runners — contains only node implementations and static type
propagation, not the rigour rules.

## Consequences
When `packages/runner` is split out in Phase 4 it depends on `flowspec` + `flowlab_nodes`
and the executor module, never on `flowlab_engine.compiler`.

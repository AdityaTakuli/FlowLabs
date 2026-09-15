# 0008 — Agent panel in the web canvas

**Status:** accepted · 2026-09-15

## Context
Decision 0004 built the snippet-composition agent as `flowlab ask`. Decision 0006 listed an agent
prompt panel as "not yet". PRD II open question 7 asks whether Local-only mode should also disable
the agent, since the agent must send *something* to the LLM.

## Decision
- **One panel, both modes.** An "✦ Ask" button next to the mode switch opens a side panel
  (`apps/web/src/agent/AgentPanel.tsx`) backed by `flowlab_api.agent.AgentService`.
- **Output is a Code Mode script.** Plans still map to reviewed snippets only. The composer now
  renders `# %%` cells (`compose(..., cells=True, output_dir=...)`): one block per step, a pinned
  `OUTPUT_DIR` (no `__file__`, which kernels lack) and `show_chart(...)` after chart snippets, so
  saved PNGs appear as rich outputs when a block runs in the kernel and nothing changes for a plain
  `python script.py`. "Save & open in Code Mode" writes the script into the project and opens it.
- **Local-only answer (PRD II Q7): the agent stays available, but only with explicit consent.**
  `POST /api/agent/ask` returns 428 `CONSENT_REQUIRED` unless `confirm_external` is true. The panel
  states exactly what is sent (goal, row count, per-column name/kind/% missing/distinct count, never
  rows or code), offers "Preview exact prompt" (`/api/agent/preview`, no LLM call, no key needed),
  and remembers consent per browser.
- **Zero-token edits.** The returned plan is editable (remove steps, edit params JSON, add snippets
  via local BM25 search); `/api/agent/compose` re-validates and re-renders without the LLM.
- **Server-side proposals.** Saving takes a `proposal_id` for a script the server composed (kept in
  memory, last 20), so the save endpoint never writes client-supplied code.
- **Key handling.** `GROQ_API_KEY` is read per request from the environment or a `.env` in the
  project folder or server working directory; status reports only whether one exists. Usage and
  cache stay in the project's `.flowlab/` (`llm_usage.jsonl`, `llm_cache/`).
- **Testability.** `create_app(..., llm_client_factory=...)` swaps in `ScriptedClient`; no test uses
  the network.

## Not yet
Plans that target Flow Mode nodes directly (Flow Spec generation), streaming planning tokens,
per-project model selection in the UI.

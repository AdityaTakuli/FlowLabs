# 0006 — Local-first web canvas, shared by the future desktop app and VS Code extension

**Status:** accepted · 2026-09-15

## Context
The founder wants a web canvas now, then a desktop app and a VS Code extension. Part I's hosted
API (Postgres, OAuth, workspaces) is not built, and the project runs on a tight budget.

## Decision
- **One UI, three shells.** `apps/web` (React 19 + React Flow 12 + Monaco, Vite) is the only
  canvas codebase. The desktop app will wrap it (Tauri/Electron) and the VS Code extension will
  host it in a webview; both talk to the same local server.
- **Local server first.** `apps/api` (`flowlab_api`, FastAPI) exposes Code Mode on
  `127.0.0.1` via `flowlab serve`. It is not the Part I multi-tenant API; its routes use the
  PRD II Section 11 vocabulary so the hosted API can adopt them later.
- **Security for a server that runs code:** loopback bind only, a per-launch token required in
  `X-FlowLab-Token` (no CORS, so other sites cannot send it), loopback `Host` check against DNS
  rebinding, loopback `Origin` + token check on the WebSocket, Monaco bundled locally (no CDN).
- **State management:** plain React state instead of Zustand/TanStack Query (PRD 5.2). The canvas
  has one screen and one live event stream; revisit when Flow Mode and multi-page navigation land.
- **Reorder by drag** is implemented in Linear view (graph positions are auto-laid-out, so a
  drag on the graph has no meaningful "position in the file").
- **Save on blur or Ctrl/⌘+S** (PRD II 6.3); auto-save is skipped while the block has a syntax
  error. Edits preview edges live without writing.

## Not yet
pylsp completions, desktop/VS Code packaging. (Flow Mode canvas: decision 0007; agent panel: 0008.)

## Rich outputs (added 2026-09-15)
- The kernel keeps the richest mimetype per `display_data` / `execute_result` (Vega-Lite > PNG/JPEG/GIF >
  SVG > HTML > Markdown > LaTeX > JSON > text) in `.flowlab/outputs/<execution_id>_<n>.<ext>`, capped
  at 10 MB per item and `snapshot_max_bytes` in total. Records carry only metadata (`rich_outputs`).
- `GET /api/output` serves a payload only for an execution of the requested file, with
  `Content-Security-Policy: sandbox`. The canvas fetches it with the token and renders images via
  object URLs and HTML in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), so notebook
  HTML cannot read the token or call the API. Scripts stay allowed so Plotly/Bokeh HTML works.

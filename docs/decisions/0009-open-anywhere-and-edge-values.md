# 0009 — Open code from anywhere, values on edges, editing on the node

**Status:** accepted · 2026-09-15

## Context
The canvas only showed the folder passed to `flowlab serve --root`. Users want to open code the way
an editor does, see the data (including API responses) moving between blocks, and edit a block
without leaving the graph. Desktop packaging (0006) is postponed.

## Decision
- **Runtime project switching.** `flowlab_api.workbench.Workbench` owns the Code Mode, Flow Mode and
  agent services behind one shared event hub. `POST /api/project/open` builds services for the new
  folder first, then shuts down the old kernels and runs, and publishes `project_changed`; every open
  tab reloads. Opening a file opens its folder and selects it. The filesystem root is refused.
- **Browsing is names only.** `GET /api/fs/browse` lists folders and `.py`/`.ipynb` files (hidden and
  build folders skipped unless asked). This adds nothing beyond what the token holder can already do
  by running code; file contents are still only read inside the open project. Indexing stops after
  50,000 entries so opening a huge folder cannot hang the server.
- **Import** (`POST /api/files/import`) copies one file into `imported/` (basename only, 5 MB cap,
  notebooks validated) for files the user does not want to open as a project.
- **Edge values.** The kernel summariser recognises HTTP responses by duck typing (`status_code`,
  `headers`, `text`/`content`), capturing status, reason, method, URL, content type, elapsed time,
  headers and a 4 KB body preview (pretty JSON when the content type says so). Dicts, lists and long
  strings get a 4 KB JSON preview. `/api/state` adds a one-line `values` label per variable
  (`short_value`), cached per execution and never cached before the snapshot exists. Previews stay
  in `.flowlab/snapshots/` on this machine, like all other samples.
- **Canvas.** Edges are a custom React Flow edge whose label shows variable names and values; a
  stale source shows the value struck through. Clicking opens an edge panel with the full captured
  values. Double-click or ✎ opens an inline Monaco editor anchored to the node (`NodeToolbar`, so it
  is not scaled by zoom); saves go through the same dependency-checked `edit` transformation.
- **Routing.** Dagre lays out each edge label as a real box (`layoutWithRoutes`), and edges are drawn
  as smooth curves through dagre's route points, so value labels never sit on top of a block that a
  long edge passes.

## Not yet
Streaming/async responses (`aiohttp`), request bodies sent, per-edge history across runs.

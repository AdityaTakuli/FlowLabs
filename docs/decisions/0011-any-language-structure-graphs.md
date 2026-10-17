# 0011 — Any-language structure graphs, and cells only where they fit

**Status:** accepted · 2026-09-16

## Context
Code Mode drew Python scripts and notebooks as blocks that run in a kernel. That fits data analysis
and ML, where a cell is a meaningful step and the value on an edge is a DataFrame. It does not fit
application code: running one route handler or one Go method "as a cell" is meaningless, and
other languages had no graph at all. The canvas should work like an editor for the whole codebase:
arrange code as a graph, drag nodes, edit a node, in whatever languages the project uses.

## Decision
- **Two workspaces, routed per file** (`flowlab_lab.languages.classify`, deterministic and explained):
  - *cells*: notebooks, `# %%` scripts, and Python scripts that import data/ML libraries and are
    mostly top-level statements. Kernel, run buttons, and live values on edges, as before.
  - *structure*: everything else, meaning Python modules that import web/app frameworks,
    libraries of functions and classes, and every non-Python language. Functions, methods,
    classes and the calls between them. Nothing runs.
  - A Python file can switch either way ("Open as cells" / "Structure view"). The choice is
    remembered per file in the browser.
- **Parser.** `tree-sitter-language-pack` with one generic walker (`flowlab_lab.structure`). It
  recognises definition, class and call node types across grammars, with fallbacks for C/C++
  declarators, Kotlin, Dart, R and Elixir. Calls resolve in this order: `self`/`this` members,
  then unique top-level names, then unique method names, then unique top-level symbols in other
  files of the same language family (drawn as read-only "external" cards). Ambiguous names are
  not guessed.
- **Editing.** A node's span, from the start of its first line (decorators included) to its end,
  is replaced with the edited text. The edit is refused when the file would have more syntax
  errors than before. It is written atomically with a backup, so "Undo change" restores the file,
  and an expected hash guards against edits on disk in the meantime.
- **Layouts.** Dragged positions are saved per file and view in `.flowlab/layouts/`, for both
  structure and cell graphs. Nodes that were never moved keep the automatic dagre layout.
- **Languages.** `/api/project` returns `code_files`, a per-file `file_info` (language, Monaco
  id, workspace, reason) and a language summary ordered by file count. The sidebar picker lists
  only languages found in the project, and defaults to the primary language when it holds at
  least 60% of the files.

## Consequences / not yet
- Grammars outside the package's local cache are downloaded once on first use; offline, those
  languages show a `GRAMMAR_UNAVAILABLE` error instead of a graph.
- Call resolution is name-based, not type-based: dynamic dispatch, and calls through variables
  holding functions, are not linked. The Architecture view (component segregation) is still
  Python-only.
- Values travelling along structure edges are static (the call-site arguments). Runtime values
  remain a cells feature.

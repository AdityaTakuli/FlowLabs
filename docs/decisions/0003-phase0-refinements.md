# 0003 — Phase 0 refinements of the PRD

**Status:** accepted · 2026-09-14

1. **One-hot output columns come from the profiled category list.** Type propagation must
   know output columns before execution. `prep.encode` (onehot/binary) emits one column per
   category in the column's profile (≤ 50 categories, else `HIGH_CARDINALITY`). The
   vocabulary actually used is still learned from the train partition: categories absent
   from train encode as all zeros.

2. **Fitting transformers accept `table | table_split`.** Leakage is a compiler rule, not a
   port-type error: a learning node on a plain table is `LEAKAGE_FIT_BEFORE_SPLIT` only when
   a `prep.split` or `model.*` node is downstream. Pure analysis flows may still scale or
   impute a whole table. Learning nodes applied to a split fit on `train` and transform every
   partition.

3. **PRD example 6.1 imputes with the median before splitting.** Under 8.5 that is leakage,
   and the compiler rejects it. The examples in `examples/` split first.

4. **Duplicate rows across splits** are detected at runtime by `prep.split` (row hashes)
   and emitted as a `node_warning`, since the compiler has no row data.

5. **Schema drift guard.** The executor checks every table output's column names and dtypes
   against the compiled schema and fails with `SCHEMA_DRIFT` on mismatch, which keeps type
   propagation honest.

6. **No `transformer` outputs yet.** Fitted preprocessing state is internal to each node in
   Phase 0; exporting it as a `transformer` port arrives with `model.export`.

7. **Tooling:** `ruff` (lint + format) replaces `black`; XGBoost/LightGBM/Prophet algorithms
   are deferred to Phase 3 with the full catalogue.

8. **Golden flows** assert run-to-run hash equality rather than committed hash values, since
   exact bytes depend on the pinned library versions encoded in `runner_version`.

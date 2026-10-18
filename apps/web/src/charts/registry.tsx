// Every chart FlowLabs draws, by id. The Results and Data pages, the Charts tab and charts opened in
// their own window all use these, so a chart looks and behaves the same everywhere. Each draws at
// card size or large (expanded, its own window), where line and scatter charts zoom and pan.
import { useState, type ReactNode } from "react";
import { BarLine, Bars, BoxPlot, Density, DotHistogram, Heatmap, LineChart, Scatter, type Series } from "./charts";
import { Segmented } from "../components/ui";
import { duration, fmt, LOWER_IS_BETTER, metricValue } from "../format";
import type { ModelResult, Profile, Project, RunResult } from "../types";

export type Category = "data" | "model" | "compare";
export type Size = "card" | "large";

export interface ChartContext {
  project: Project;
  profile: Profile | null;
  run: RunResult | null;
  /** The model the Model charts describe: the one picked, or the best. */
  model: ModelResult | null;
}

export interface ChartSpec {
  id: string;
  category: Category;
  title: string;
  sub?: string;
  /** Width in the grid: s = a third, m = half, l = two thirds, w = full. */
  span: "s" | "m" | "l" | "w";
  /** Only reachable by id (the Data page's curve view), not listed in grids. */
  hidden?: boolean;
  render: (size: Size) => ReactNode;
}

export const CATEGORY_LABELS: Record<Category, string> = { data: "Data", model: "Model", compare: "Compare" };

/** Charts shown on the Overview tab, in order, when they exist. */
export const OVERVIEW = ["compare-score-time", "model-separation", "model-scatter", "model-importance", "model-confusion", "data-target", "data-corr", "compare-folds"];

const h = (size: Size, card: number, large: number) => (size === "large" ? large : card);

const COMPARE_METRICS: Record<string, string[]> = {
  classification: ["accuracy", "balanced_accuracy", "f1_macro", "precision_macro", "recall_macro", "roc_auc", "log_loss"],
  regression: ["r2", "rmse", "mae", "mape"],
};
const METRIC_SHORT: Record<string, string> = {
  accuracy: "Accuracy", balanced_accuracy: "Balanced acc.", f1_macro: "F1", precision_macro: "Precision", recall_macro: "Recall",
  roc_auc: "ROC AUC", log_loss: "Log loss", r2: "R²", rmse: "RMSE", mae: "MAE", mape: "MAPE",
};

function Confusion({ model, size }: { model: ModelResult; size: Size }) {
  const [share, setShare] = useState(false);
  const confusion = model.details!.confusion!;
  return (
    <div className="col" style={{ gap: 10 }}>
      <Segmented value={share ? "share" : "count"} onChange={(v) => setShare(v === "share")} options={[{ value: "count", label: "Counts" }, { value: "share", label: "Row %" }]} />
      <Heatmap
        labels={confusion.labels}
        matrix={confusion.matrix}
        normalizeRows={share}
        accentDiagonal
        cell={size === "large" ? 120 : 64}
        area={size === "large" ? 900 : 420}
        format={(v) => (share ? `${Math.round(v * 100)}` : fmt(v))}
        title={(r, c) => `true ${r}, predicted ${c}`}
      />
    </div>
  );
}

function Importance({ model, size }: { model: ModelResult; size: Size }) {
  const [kind, setKind] = useState<"permutation" | "native">("permutation");
  const items = (kind === "permutation" ? model.importance?.permutation : model.importance?.native) ?? [];
  return (
    <div className="col" style={{ gap: 10 }}>
      {model.importance?.native?.length ? (
        <Segmented value={kind} onChange={setKind} options={[{ value: "permutation", label: "Inputs" }, { value: "native", label: "Model's own" }]} />
      ) : null}
      <Bars items={items.slice(0, size === "large" ? 40 : 12).map((f) => ({ label: f.feature, value: f.value }))} format={(v) => fmt(v)} signed highlight={items[0]?.feature} />
    </div>
  );
}

function curveSeries(model: ModelResult): { loss: Series[]; score: Series[] } {
  const history = model.history ?? [];
  const pick = (key: string) => history.filter((p) => typeof p[key] === "number").map((p) => [p.epoch, p[key]!] as [number, number]);
  return {
    loss: [{ name: "training loss", points: pick("loss") }, { name: "validation loss", points: pick("val_loss"), colour: "var(--signal)" }].filter((s) => s.points.length),
    score: ["val_accuracy", "val_r2"].map((k) => ({ name: k.replace("val_", "validation "), points: pick(k), colour: "var(--c-green)" })).filter((s) => s.points.length),
  };
}

function bestLabel(run: RunResult | null): string | undefined {
  return run?.models.find((m) => m.id === run.best_model_id)?.label;
}

export function chartSpecs(ctx: ChartContext): ChartSpec[] {
  const specs: ChartSpec[] = [];
  const { project, profile, run, model } = ctx;
  const target = profile?.target;
  const columns = profile?.columns ?? [];

  // ------------------------------------------------------------------------------------- data
  if (target?.classes && project.task === "classification") {
    specs.push({
      id: "data-target", category: "data", span: "m", title: `${target.name}: rows per class`, sub: "How many rows each class has. Very uneven classes need balancing.",
      render: (size) => <Bars items={target.classes!.slice(0, size === "large" ? 60 : 15).map((c) => ({ label: c.value, value: c.count }))} format={(v) => fmt(v)} colour="var(--signal)" />,
    });
  } else if (target?.histogram) {
    specs.push({
      id: "data-target", category: "data", span: "m", title: `${target.name}: distribution`, sub: "The values the model learns to predict.",
      render: (size) => <DotHistogram edges={target.histogram!.edges} groups={[{ label: target.name, counts: target.histogram!.counts, colour: "var(--signal)" }]} height={h(size, 200, 460)} xLabel={target.name} />,
    });
  }
  for (const column of columns) {
    if (!column.histogram || column.histogram.edges.length < 3 || column.name === project.target) continue;
    const split = column.by_target && column.by_target.length > 1;
    const groups = split
      ? column.by_target!.map((g, i) => ({ ...g, colour: column.by_target!.length === 2 ? (i === 1 ? "var(--signal)" : "var(--c-blue)") : undefined }))
      : [{ label: column.name, counts: column.histogram.counts }];
    specs.push({
      id: `data-dist-${column.name}`, category: "data", span: "s", title: column.name, sub: split ? `Split by ${project.target}` : "All rows",
      render: (size) => <DotHistogram edges={column.histogram!.edges} groups={groups} height={h(size, 190, 480)} xLabel={column.name} />,
    });
    if (split) {
      specs.push({
        id: `data-density-${column.name}`, category: "data", span: "s", hidden: true, title: `${column.name} by ${project.target}`, sub: "Each class's values as a smooth curve.",
        render: (size) => <Density edges={column.histogram!.edges} groups={groups} height={h(size, 200, 480)} xLabel={column.name} />,
      });
    }
  }
  for (const column of columns) {
    if (column.kind !== "categorical" || !column.top?.length || column.name === project.target || column.unique > 200) continue;
    specs.push({
      id: `data-top-${column.name}`, category: "data", span: "s", title: column.name, sub: `${column.unique.toLocaleString()} different values`,
      render: (size) => <Bars items={column.top!.slice(0, size === "large" ? 40 : 8).map((t) => ({ label: t.value, value: t.count }))} format={(v) => fmt(v)} colour="var(--c-purple)" />,
    });
  }
  const missing = columns.filter((c) => c.missing > 0);
  if (missing.length) {
    specs.push({
      id: "data-missing", category: "data", span: "m", title: "Gaps per column", sub: "Share of empty cells. Columns over a third empty may be better dropped.",
      render: () => <Bars items={missing.sort((a, b) => b.missing_pct - a.missing_pct).map((c) => ({ label: c.name, value: c.missing_pct }))} max={100} format={(v) => `${v}%`} colour="var(--c-orange)" />,
    });
  }
  const corr = profile?.correlations;
  if (corr && corr.columns.length > 1) {
    specs.push({
      id: "data-corr", category: "data", span: "l", title: "How numbers move together", sub: "Correlation from −1 to 1. Near 1 means two columns carry the same information.",
      render: (size) => {
        const shown = size === "large" ? corr.columns : corr.columns.slice(0, 14);
        return <Heatmap labels={shown} matrix={corr.matrix.slice(0, shown.length).map((r) => r.slice(0, shown.length))} diverging format={(v) => v.toFixed(2)} cell={size === "large" ? 96 : 64} area={size === "large" ? 1100 : 560} />;
      },
    });
    if (corr.with_target?.length) {
      specs.push({
        id: "data-links", category: "data", span: "m", title: `Strongest links to ${project.target}`, sub: "Absolute correlation with the target. A first hint only: models also find non-linear patterns.",
        render: (size) => <Bars items={corr.with_target!.slice(0, size === "large" ? 40 : 12).map((c) => ({ label: c.column, value: c.value }))} max={1} format={(v) => v.toFixed(2)} />,
      });
    }
  }

  // ------------------------------------------------------------------------------------ model
  const d = model?.status === "done" ? (model.details ?? {}) : null;
  if (model && d) {
    const name = model.label;
    if (d.confusion) {
      specs.push({ id: "model-confusion", category: "model", span: "m", title: "Confusion matrix", sub: `${name}. Rows: true class. Columns: predicted. The diagonal is correct.`, render: (size) => <Confusion model={model} size={size} /> });
    }
    if (d.separation && d.separation.groups.length > 1) {
      const sep = d.separation;
      specs.push({
        id: "model-separation", category: "model", span: "m", title: "How well the classes separate", sub: `${name}. Test rows of each true class, by the ${sep.axis}. Less overlap is better.`,
        render: (size) => <Density edges={sep.edges} groups={sep.groups.map((g, i) => ({ ...g, colour: sep.groups.length === 2 ? (i === 1 ? "var(--signal)" : "var(--c-blue)") : undefined }))} xLabel={sep.axis} height={h(size, 230, 500)} />,
      });
    }
    if (d.roc) {
      specs.push({
        id: "model-roc", category: "model", span: "m", title: `ROC curve, AUC ${metricValue("roc_auc", model.metrics?.roc_auc)}`, sub: `${name}. Positives found (up) for each false alarm (right).`,
        render: (size) => <LineChart series={[{ name: `positive = ${d.positive_class}`, points: d.roc! }]} diagonal domain={{ x: [0, 1], y: [0, 1] }} xLabel="false positive rate" area height={h(size, 240, 520)} interactive={size === "large"} />,
      });
    }
    if (d.pr) {
      specs.push({
        id: "model-pr", category: "model", span: "m", title: "Precision vs recall", sub: `${name}. Finding more positives (right) costs precision (down).`,
        render: (size) => <LineChart series={[{ name: "precision", points: d.pr!, colour: "var(--c-purple)" }]} domain={{ x: [0, 1], y: [0, 1] }} xLabel="recall" height={h(size, 240, 520)} interactive={size === "large"} />,
      });
    }
    if (d.calibration && d.calibration.length > 2) {
      specs.push({
        id: "model-calibration", category: "model", span: "m", title: "Are probabilities honest?", sub: `${name}. On the diagonal, "70%" comes true 70% of the time.`,
        render: (size) => <LineChart series={[{ name: "observed share", points: d.calibration!.map(([p, o]) => [p, o] as [number, number]), colour: "var(--c-orange)" }]} diagonal domain={{ x: [0, 1], y: [0, 1] }} xLabel="predicted probability" height={h(size, 240, 520)} interactive={size === "large"} />,
      });
    }
    if (d.scatter) {
      specs.push({
        id: "model-scatter", category: "model", span: "l", title: "Predicted vs actual", sub: `${name}. One dot per test row. On the line is perfect.`,
        render: (size) => <Scatter points={d.scatter!} range={d.range} xLabel={`actual ${run?.target ?? ""}`} yLabel="predicted" height={h(size, 300, 560)} interactive={size === "large"} />,
      });
    }
    if (d.residual_histogram) {
      specs.push({
        id: "model-errors", category: "model", span: "m", title: "Errors", sub: `${name}. Actual minus predicted. Centred on zero and narrow is best.`,
        render: (size) => <DotHistogram edges={d.residual_histogram!.edges} groups={[{ label: "test rows", counts: d.residual_histogram!.counts }]} xLabel={`actual − predicted ${run?.target ?? ""}`} unitLabel="test rows" height={h(size, 220, 480)} />,
      });
    }
    if (model.importance?.permutation?.length || model.importance?.native?.length) {
      specs.push({ id: "model-importance", category: "model", span: "m", title: "What drives predictions", sub: `${name}. How much the score drops when an input is shuffled.`, render: (size) => <Importance model={model} size={size} /> });
    }
    if (d.per_class && d.per_class.length > 1) {
      const rows = d.per_class;
      specs.push({
        id: "model-per-class", category: "model", span: "m", title: "Scores per class", sub: `${name}. Which classes are hard to get right.`,
        render: (size) => (
          <Heatmap
            labels={rows.map((r) => r.label)}
            columns={["precision", "recall", "f1"]}
            matrix={rows.map((r) => [r.precision, r.recall, r.f1])}
            format={(v) => `${Math.round(v * 100)}%`}
            cell={size === "large" ? 110 : 70}
            area={size === "large" ? 700 : 360}
          />
        ),
      });
    }
    const { loss, score } = curveSeries(model);
    if (loss.length) {
      specs.push({
        id: "model-curves", category: "model", span: "m", title: "Training curves", sub: `${name}. When validation loss rises while training loss falls, the network overfits.`,
        render: (size) => (
          <>
            <LineChart series={loss} xLabel="epoch" height={h(size, 220, 420)} interactive={size === "large"} />
            {score.length > 0 && <LineChart series={score} xLabel="epoch" height={h(size, 140, 260)} interactive={size === "large"} />}
          </>
        ),
      });
    }
  }

  // ---------------------------------------------------------------------------------- compare
  if (run) {
    const done = run.models.filter((m) => m.status === "done" && m.metrics?.[run.metric] !== undefined);
    const better = (a: ModelResult, b: ModelResult) => {
      const [x, y] = [a.metrics?.[run.metric] ?? NaN, b.metrics?.[run.metric] ?? NaN];
      return LOWER_IS_BETTER.has(run.metric) ? x - y : y - x;
    };
    const ranked = [...done].sort(better);
    const best = bestLabel(run);
    if (ranked.length >= 2) {
      specs.push({
        id: "compare-score-time", category: "compare", span: "w", title: "Score and training time", sub: `${run.metric_label} on the test rows (bars), seconds to train (line).`,
        render: (size) => (
          <BarLine
            items={ranked.map((m) => ({ label: m.label, bar: m.metrics?.[run.metric] ?? null, line: m.fit_seconds ?? null }))}
            barLabel={run.metric_label}
            lineLabel="seconds to train"
            formatBar={(v) => metricValue(run.metric, v)}
            formatLine={(v) => duration(v)}
            highlight={best}
            height={h(size, 280, 560)}
          />
        ),
      });
      const metrics = (COMPARE_METRICS[run.task] ?? []).filter((m) => ranked.some((x) => x.metrics?.[m] !== undefined));
      if (metrics.length > 1) {
        const values = ranked.map((m) => metrics.map((k) => m.metrics?.[k] ?? NaN));
        const shade = values.map((row) =>
          row.map((v, j) => {
            const col = values.map((r) => r[j]!).filter(Number.isFinite);
            const [lo, hi] = [Math.min(...col), Math.max(...col)];
            if (!Number.isFinite(v) || hi === lo) return 0.15;
            const t = (v - lo) / (hi - lo);
            return 0.1 + 0.9 * (LOWER_IS_BETTER.has(metrics[j]!) ? 1 - t : t);
          }),
        );
        specs.push({
          id: "compare-metrics", category: "compare", span: "l", title: "Every metric, every model", sub: "Darker is better within each column, so you can see where each model wins.",
          render: (size) => (
            <Heatmap
              labels={ranked.map((m) => m.label)}
              columns={metrics.map((k) => METRIC_SHORT[k] ?? k)}
              matrix={values}
              shade={shade}
              format={(v) => (Number.isFinite(v) ? fmt(v) : "–")}
              cell={size === "large" ? 120 : 76}
              area={size === "large" ? 1100 : 620}
              title={(r, c) => `${r}: ${c}`}
            />
          ),
        });
      }
      const withRoc = ranked.filter((m) => m.details?.roc);
      if (withRoc.length >= 2) {
        specs.push({
          id: "compare-roc", category: "compare", span: "m", title: "ROC curves of every model", sub: "The curve furthest up and to the left ranks positives best.",
          render: (size) => <LineChart series={withRoc.map((m) => ({ name: m.label, points: m.details!.roc!, colour: m.label === best ? "var(--signal)" : undefined }))} diagonal domain={{ x: [0, 1], y: [0, 1] }} xLabel="false positive rate" height={h(size, 260, 540)} interactive={size === "large"} />,
        });
      }
      const withPr = ranked.filter((m) => m.details?.pr);
      if (withPr.length >= 2) {
        specs.push({
          id: "compare-pr", category: "compare", span: "m", title: "Precision vs recall, every model", sub: "Higher for longer is better.",
          render: (size) => <LineChart series={withPr.map((m) => ({ name: m.label, points: m.details!.pr!, colour: m.label === best ? "var(--signal)" : undefined }))} domain={{ x: [0, 1], y: [0, 1] }} xLabel="recall" height={h(size, 260, 540)} interactive={size === "large"} />,
        });
      }
    }
    const folds = done.filter((m) => m.cv && m.cv.folds.length > 1);
    if (folds.length) {
      specs.push({
        id: "compare-folds", category: "compare", span: "m", title: "Cross-validation folds", sub: "Each dot is one fold; the box holds the middle half. Narrow means steady.",
        render: (size) => <BoxPlot rows={folds.map((m) => ({ label: m.label, values: m.cv!.folds }))} format={(v) => metricValue(folds[0]!.cv!.metric, v)} highlight={best} rowHeight={size === "large" ? 56 : 34} label="Scores per cross-validation fold" />,
      });
    }
  }
  return specs;
}

export function findChart(ctx: ChartContext, id: string): ChartSpec | undefined {
  return chartSpecs(ctx).find((s) => s.id === id);
}

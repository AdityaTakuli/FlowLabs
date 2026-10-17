export function fmt(value: unknown, digits = 3): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "–";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return value.toExponential(2);
    if (Number.isInteger(value)) return value.toLocaleString();
    return Number(value.toPrecision(digits)).toString();
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `${(value * 100).toFixed(digits)}%`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

export function ago(iso: string | undefined | null): string {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds === null) return "–";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** Metrics where a lower number is better. */
export const LOWER_IS_BETTER = new Set(["rmse", "mae", "mape", "log_loss"]);

export function metricValue(name: string, value: number | undefined | null): string {
  if (value === undefined || value === null) return "–";
  if (["accuracy", "balanced_accuracy", "f1_macro", "f1_weighted", "precision_macro", "recall_macro"].includes(name)) return pct(value);
  if (name === "mape") return `${value.toFixed(1)}%`;
  return fmt(value);
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return fmt(value, 5);
  return String(value);
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** "line 3: KeyError: ..." -> 3 (errors from code steps name their line) */
export function lineOf(message: string | undefined | null): number | null {
  const match = /line (\d+)/.exec(message ?? "");
  return match ? Number(match[1]) : null;
}

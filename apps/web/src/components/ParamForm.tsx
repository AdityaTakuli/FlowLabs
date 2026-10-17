// Forms generated from the engine's parameter definitions (see core/catalogue.py).
import { useState } from "react";
import type { ColumnKind, Param } from "../types";
import { Icon } from "./Icon";
import { CommitInput, KindBadge, Segmented, Switch } from "./ui";

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
}

const TOKENS: { value: string; label: string; kind?: ColumnKind }[] = [
  { value: "@numeric", label: "All numbers", kind: "numeric" },
  { value: "@categorical", label: "All categories", kind: "categorical" },
  { value: "@boolean", label: "All yes/no", kind: "boolean" },
  { value: "@datetime", label: "All dates", kind: "datetime" },
  { value: "@text", label: "All free text", kind: "text" },
  { value: "@all", label: "Every column" },
];

/** Parameters that only matter for some choices: "<owner>.<param>" -> shown when true. */
const VISIBLE: Record<string, (v: Record<string, unknown>) => boolean> = {
  "impute.fill_value": (v) => v.strategy === "constant",
  "impute.neighbors": (v) => v.strategy === "knn",
  "encode.max_categories": (v) => v.method === "onehot",
  "encode.drop_binary": (v) => v.method === "onehot",
  "clip_outliers.factor": (v) => v.method !== "percentile",
  "clip_outliers.lower": (v) => v.method === "percentile",
  "clip_outliers.upper": (v) => v.method === "percentile",
  "remove_outliers.threshold": (v) => v.method !== "isolation_forest",
  "remove_outliers.contamination": (v) => v.method === "isolation_forest",
  "linear_regression.alpha": (v) => v.penalty !== "none",
  "linear_regression.l1_ratio": (v) => v.penalty === "elasticnet",
  "filter_rows.value": (v) => !String(v.operator ?? "").includes("missing"),
};

export function tokenLabel(value: string): string {
  return TOKENS.find((t) => t.value === value)?.label ?? value;
}

function NumberField({ param, value, onChange }: { param: Param; value: number; onChange: (v: number) => void }) {
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const integer = param.type === "int";
  const log = Boolean(param.log) && min > 0;
  const span = max - min;
  const slider = span > 0 && (log || span <= 5000);
  const toSlider = (v: number) => (log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / span) * 1000;
  const fromSlider = (s: number) => {
    const t = s / 1000;
    let v = log ? Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))) : min + t * span;
    if (integer) v = Math.round(v);
    else v = Number(v.toPrecision(3));
    return v;
  };
  const current = Number.isFinite(value) ? value : Number(param.default ?? min);
  return (
    <div className="field-row">
      {slider && (
        <input type="range" min={0} max={1000} value={toSlider(Math.min(max, Math.max(min, current)))} onChange={(e) => onChange(fromSlider(Number(e.target.value)))} aria-label={param.label} />
      )}
      <input
        type="number"
        value={current}
        min={min}
        max={max}
        step={integer ? 1 : (param.step ?? "any")}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(integer ? Math.round(v) : v);
        }}
      />
    </div>
  );
}

function ColumnsField({ value, onChange, columns, kinds }: { value: string[]; onChange: (v: string[]) => void; columns: ColumnInfo[]; kinds?: ColumnKind[] }) {
  const allowed = (kind?: ColumnKind) => !kinds?.length || !kind || kinds.includes(kind);
  const options = [
    ...TOKENS.filter((t) => allowed(t.kind) && !value.includes(t.value)).map((t) => ({ value: t.value, label: t.label })),
    ...columns.filter((c) => allowed(c.kind) && !value.includes(c.name)).map((c) => ({ value: c.name, label: c.name })),
  ];
  const missing = value.filter((v) => !v.startsWith("@") && !columns.some((c) => c.name === v));
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="chips">
        {value.length === 0 && <span className="faint small">None chosen</span>}
        {value.map((item) => (
          <span key={item} className={`chip ${item.startsWith("@") ? "token" : ""}`} title={missing.includes(item) ? "This column no longer exists at this step" : undefined} style={missing.includes(item) ? { borderColor: "#fb7185", color: "#fb7185" } : undefined}>
            {item.startsWith("@") ? tokenLabel(item) : item}
            <button onClick={() => onChange(value.filter((v) => v !== item))} aria-label={`Remove ${item}`}>
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
      </div>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onChange([...value, e.target.value]);
        }}
      >
        <option value="">+ Add columns…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value.startsWith("@") ? `◆ ${o.label}` : o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ------------------------------------------------------------------------------- layers

export type Layer = { type: string; units?: number; activation?: string; rate?: number; filters?: number; kernel?: number; size?: number; stride?: number };

const LAYER_LABELS: Record<string, string> = { dense: "Dense", dropout: "Dropout", batchnorm: "Batch norm", conv: "Convolution", maxpool: "Max pool", avgpool: "Average pool" };
const NEW_LAYER: Record<string, Layer> = {
  dense: { type: "dense", units: 64, activation: "relu" },
  dropout: { type: "dropout", rate: 0.2 },
  batchnorm: { type: "batchnorm" },
  conv: { type: "conv", filters: 32, kernel: 3, activation: "relu" },
  maxpool: { type: "maxpool", size: 2 },
  avgpool: { type: "avgpool", size: 2 },
};

export function NetworkDiagram({ layers, inputs, outputs }: { layers: Layer[]; inputs?: string; outputs?: string }) {
  const height = (units: number) => Math.max(10, Math.min(70, 10 + Math.log2(units + 1) * 7));
  return (
    <div className="net-diagram" aria-label="Network diagram">
      <div className="net-layer">
        <div className="net-block io" style={{ height: 40 }} />
        <span className="tiny faint">{inputs ?? "inputs"}</span>
      </div>
      {layers.map((layer, i) => {
        const kind = layer.type;
        const cls = kind === "dropout" ? "dropout" : kind === "batchnorm" ? "bn" : kind === "conv" ? "conv" : kind.endsWith("pool") ? "pool" : "";
        const h = kind === "dense" ? height(layer.units ?? 32) : kind === "conv" ? height(layer.filters ?? 32) : 28;
        const caption = kind === "dense" ? `${layer.units}` : kind === "conv" ? `${layer.filters}×${layer.kernel}` : kind === "dropout" ? `${Math.round((layer.rate ?? 0) * 100)}%` : kind.endsWith("pool") ? `÷${layer.size}` : "BN";
        return (
          <div className="net-layer" key={i}>
            <div className={`net-block ${cls}`} style={{ height: h, width: kind === "dropout" || kind === "batchnorm" ? 8 : 18 }} />
            <span className="tiny faint">{caption}</span>
          </div>
        );
      })}
      <div className="net-layer">
        <div className="net-block io" style={{ height: 24 }} />
        <span className="tiny faint">{outputs ?? "output"}</span>
      </div>
    </div>
  );
}

function LayersField({ param, value, onChange }: { param: Param; value: Layer[]; onChange: (v: Layer[]) => void }) {
  const types = param.layer_types ?? ["dense", "dropout", "batchnorm"];
  const activations = param.activations ?? ["relu", "tanh", "sigmoid", "linear"];
  const update = (index: number, patch: Partial<Layer>) => onChange(value.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const move = (index: number, by: number) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const number = (index: number, key: keyof Layer, min: number, max: number, step = 1) => (
    <input type="number" value={Number(value[index]![key] ?? min)} min={min} max={max} step={step} onChange={(e) => update(index, { [key]: Number(e.target.value) } as Partial<Layer>)} />
  );
  return (
    <div className="col" style={{ gap: 8 }}>
      <NetworkDiagram layers={value} />
      <div className="layer-list">
        {value.map((layer, index) => (
          <div className="layer" key={index}>
            <span className="handle">{index + 1}</span>
            <div className="layer-fields">
              <select value={layer.type} onChange={(e) => update(index, { ...NEW_LAYER[e.target.value], type: e.target.value })}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {LAYER_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
              {layer.type === "dense" && (
                <>
                  {number(index, "units", 1, 4096)}
                  <span className="tiny dim">units</span>
                </>
              )}
              {layer.type === "conv" && (
                <>
                  {number(index, "filters", 1, 1024)}
                  <span className="tiny dim">filters</span>
                  {number(index, "kernel", 1, 11)}
                  <span className="tiny dim">kernel</span>
                </>
              )}
              {(layer.type === "dense" || layer.type === "conv") && (
                <select value={layer.activation ?? "relu"} onChange={(e) => update(index, { activation: e.target.value })}>
                  {activations.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              )}
              {layer.type === "dropout" && (
                <>
                  {number(index, "rate", 0, 0.9, 0.05)}
                  <span className="tiny dim">drop rate</span>
                </>
              )}
              {layer.type.endsWith("pool") && (
                <>
                  {number(index, "size", 2, 8)}
                  <span className="tiny dim">size</span>
                </>
              )}
            </div>
            <div className="row" style={{ gap: 2 }}>
              <button className="ghost icon-only" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                <Icon name="arrowUp" size={12} />
              </button>
              <button className="ghost icon-only" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                <Icon name="arrowDown" size={12} />
              </button>
              <button className="ghost icon-only" onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label="Remove layer">
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 4 }}>
        {types.map((t) => (
          <button key={t} className="small" onClick={() => onChange([...value, { ...NEW_LAYER[t]! }])}>
            <Icon name="plus" size={11} /> {LAYER_LABELS[t] ?? t}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- the form

export function ParamField({ param, value, onChange, columns, owner }: { param: Param; value: unknown; onChange: (v: unknown) => void; columns: ColumnInfo[]; owner?: string }) {
  const [open, setOpen] = useState(false);
  void owner;
  let control: React.ReactNode;
  switch (param.type) {
    case "int":
    case "float":
      control = <NumberField param={param} value={Number(value)} onChange={onChange} />;
      break;
    case "bool":
      return (
        <div className="field">
          <Switch on={Boolean(value)} onChange={onChange} label={param.label} />
          {param.help && <span className="help">{param.help}</span>}
        </div>
      );
    case "select": {
      const options = param.options ?? [];
      control =
        options.length <= 3 && options.every((o) => o.label.length < 14) ? (
          <Segmented value={String(value)} options={options.map((o) => ({ value: String(o.value), label: o.label }))} onChange={(v) => onChange(options.find((o) => String(o.value) === v)?.value ?? v)} />
        ) : (
          <select value={String(value)} onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)?.value ?? e.target.value)}>
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        );
      break;
    }
    case "text":
      control = <CommitInput value={String(value ?? "")} onCommit={onChange} />;
      break;
    case "column":
      control = (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose a column…</option>
          {columns
            .filter((c) => !param.kinds?.length || param.kinds.includes(c.kind))
            .map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
        </select>
      );
      break;
    case "columns":
      control = <ColumnsField value={(value as string[]) ?? []} onChange={onChange} columns={columns} kinds={param.kinds} />;
      break;
    case "parts": {
      const chosen = new Set((value as string[]) ?? []);
      control = (
        <div className="row wrap" style={{ gap: 10 }}>
          {(param.options ?? []).map((o) => (
            <label key={String(o.value)} className="row small" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={chosen.has(String(o.value))}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(String(o.value));
                  else next.delete(String(o.value));
                  onChange([...next]);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "layers":
      control = <LayersField param={param} value={(value as Layer[]) ?? (param.default as Layer[])} onChange={onChange} />;
      break;
  }
  return (
    <div className="field">
      <label>
        {param.label}
        {param.help && (
          <button className="ghost icon-only" style={{ padding: 0 }} onClick={() => setOpen(!open)} aria-label="Explain">
            <Icon name="info" size={12} />
          </button>
        )}
      </label>
      {control}
      {param.help && open && <span className="help">{param.help}</span>}
    </div>
  );
}

export function ParamForm({ params, values, onChange, columns, owner, skip }: { params: Param[]; values: Record<string, unknown>; onChange: (name: string, value: unknown) => void; columns: ColumnInfo[]; owner: string; skip?: string[] }) {
  return (
    <div>
      {params
        .filter((p) => !skip?.includes(p.name))
        .filter((p) => VISIBLE[`${owner}.${p.name}`]?.(values) ?? true)
        .map((param) => (
          <ParamField key={param.name} param={param} owner={owner} value={values[param.name] ?? param.default} onChange={(v) => onChange(param.name, v)} columns={columns} />
        ))}
    </div>
  );
}

export { KindBadge };

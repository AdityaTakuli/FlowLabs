import { useMemo, useState } from "react";
import { filterColumns } from "./model";
import type { ColumnSchema, JsonSchema } from "./types";
import { Icon } from "../components/Icon";

/**
 * Param form generated from a node's JSON Schema (PRD 11.3). Adding a node to the catalogue never
 * needs frontend code: `x-widget`, `x-descriptions` and `x-filter` drive the controls. Unset
 * keys stay absent from the spec so the node's own defaults apply.
 */
export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  columns: ColumnSchema[] | null;
  datasetRefs: string[];
  invalidFields?: Set<string>;
}

export function SchemaForm({ schema, value, onChange, columns, datasetRefs, invalidFields }: SchemaFormProps) {
  const [raw, setRaw] = useState(false);
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const set = (key: string, next: unknown) => {
    const copy = { ...value };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  return (
    <div className="schema-form">
      <div className="form-toolbar">
        <span className="dim small">{properties.length ? `${properties.length} parameter${properties.length === 1 ? "" : "s"}` : "No parameters"}</span>
        <button className="link-button" onClick={() => setRaw((r) => !r)}>
          {raw ? "Form" : "Edit as JSON"}
        </button>
      </div>
      {raw ? (
        <JsonEditor value={value} onChange={onChange} />
      ) : (
        properties.map(([key, prop]) => (
          <Field
            key={key}
            name={key}
            schema={resolve(prop, schema)}
            root={schema}
            required={required.has(key)}
            value={value[key]}
            onChange={(next) => set(key, next)}
            columns={columns}
            datasetRefs={datasetRefs}
            invalid={invalidFields?.has(key) ?? false}
          />
        ))
      )}
    </div>
  );
}

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (schema.$ref?.startsWith("#/$defs/")) {
    const target = root.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (target) return { ...target, ...schema, $ref: undefined };
  }
  return schema;
}

/** `anyOf: [X, {type: null}]` → X plus nullable; other unions are kept. */
function unwrapNullable(schema: JsonSchema, root: JsonSchema): { inner: JsonSchema; nullable: boolean } {
  if (!schema.anyOf) return { inner: schema, nullable: false };
  const options = schema.anyOf.map((s) => resolve(s, root));
  const nonNull = options.filter((s) => s.type !== "null");
  const nullable = nonNull.length !== options.length;
  const only = nonNull[0];
  if (nonNull.length === 1 && only) {
    const { anyOf: _drop, ...rest } = schema;
    return { inner: { ...only, ...rest, type: only.type }, nullable };
  }
  return { inner: { ...schema, anyOf: nonNull }, nullable };
}

function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface FieldProps {
  name: string;
  schema: JsonSchema;
  root: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
  columns: ColumnSchema[] | null;
  datasetRefs: string[];
  invalid: boolean;
}

function Field(props: FieldProps) {
  const { name, schema, root, required, value } = props;
  const { inner, nullable } = unwrapNullable(schema, root);
  const title = inner.title ?? name;
  const isSet = value !== undefined;
  const fallback = inner.default;
  return (
    <div className={`field ${props.invalid ? "invalid" : ""}`}>
      <div className="field-head">
        <label htmlFor={`param-${name}`}>
          {title}
          {required && <span className="required" title="required"> *</span>}
        </label>
        {isSet && !required && (
          <button className="link-button small" onClick={() => props.onChange(undefined)} title="Use the default">
            reset
          </button>
        )}
      </div>
      <Control {...props} schema={inner} nullable={nullable} />
      {inner.description && <div className="field-help">{inner.description}</div>}
      {!isSet && fallback !== undefined && fallback !== null && typeOf(inner) !== "boolean" && (
        <div className="field-help">Default: {display(fallback)}</div>
      )}
    </div>
  );
}

function Control(props: FieldProps & { nullable: boolean }) {
  const { name, schema, root, value, onChange, columns, datasetRefs } = props;
  const id = `param-${name}`;
  const widget = schema["x-widget"];
  const type = typeOf(schema);

  if (widget === "dataset-select") {
    return (
      <select id={id} value={display(value)} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{datasetRefs.length ? "Choose a dataset…" : "Bind a dataset in flow settings first"}</option>
        {datasetRefs.map((ref) => (
          <option key={ref} value={ref}>
            {ref}
          </option>
        ))}
      </select>
    );
  }

  if (widget === "column-select") {
    return <ColumnSelect id={id} schema={schema} columns={columns} value={value} onChange={onChange} />;
  }

  if (widget === "column-multiselect" || (type === "array" && schema.items && typeOf(schema.items) === "string" && !schema.items.enum)) {
    if (widget === "column-multiselect" && columns) {
      return <ColumnMulti schema={schema} columns={columns} value={value} onChange={onChange} />;
    }
    return (
      <input
        id={id}
        placeholder={widget === "column-multiselect" ? "Connect an input to pick columns, or type a, b, c" : "a, b, c"}
        value={Array.isArray(value) ? value.join(", ") : ""}
        onChange={(e) => {
          const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
          onChange(items.length ? items : undefined);
        }}
      />
    );
  }

  if (schema.enum) {
    const options = schema.enum;
    const descriptions = schema["x-descriptions"] ?? {};
    const current = value ?? schema.default;
    if (widget === "radio-cards") {
      return (
        <div className="radio-cards" role="radiogroup" aria-label={schema.title ?? name}>
          {options.map((option) => (
            <button
              key={String(option)}
              role="radio"
              aria-checked={current === option}
              className={`radio-card ${current === option ? "active" : ""}`}
              onClick={() => onChange(option)}
            >
              <span className="radio-title">{humanise(String(option))}</span>
              {descriptions[String(option)] && <span className="radio-desc">{descriptions[String(option)]}</span>}
            </button>
          ))}
        </div>
      );
    }
    return (
      <>
        <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : options.find((o) => String(o) === e.target.value))}>
          <option value="">{schema.default !== undefined && schema.default !== null ? `Default (${humanise(String(schema.default))})` : "—"}</option>
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {humanise(String(option))}
            </option>
          ))}
        </select>
        {current !== undefined && descriptions[String(current)] && <div className="field-teach">{descriptions[String(current)]}</div>}
      </>
    );
  }

  if (type === "array" && schema.items?.enum) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className="chip-row">
        {schema.items.enum.map((option) => (
          <label key={String(option)} className={`chip toggle-chip ${selected.has(String(option)) ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={selected.has(String(option))}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(String(option));
                else next.delete(String(option));
                onChange(next.size ? schema.items!.enum!.filter((o) => next.has(String(o))) : undefined);
              }}
            />
            {humanise(String(option))}
          </label>
        ))}
      </div>
    );
  }

  if (type === "boolean") {
    const checked = value === undefined ? Boolean(schema.default) : Boolean(value);
    return (
      <label className="toggle">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {checked ? "Yes" : "No"}
      </label>
    );
  }

  if (type === "integer" || type === "number") {
    return <NumberInput id={id} schema={schema} value={value} onChange={onChange} integer={type === "integer"} />;
  }

  if (type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return (
      <MapEditor
        valueSchema={resolve(schema.additionalProperties, root)}
        root={root}
        value={value}
        onChange={onChange}
        columns={/override|order|column|rename|mapping/i.test(name) ? columns : null}
      />
    );
  }

  if (type === "string") {
    return (
      <input
        id={id}
        value={display(value)}
        minLength={schema.minLength}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }

  // Unions of primitives (e.g. number | string) and anything unrecognised: a typed text box.
  return <LooseInput id={id} value={value} onChange={onChange} />;
}

function humanise(text: string): string {
  return text.replace(/_/g, " ");
}

function NumberInput({ id, schema, value, onChange, integer }: { id: string; schema: JsonSchema; value: unknown; onChange: (v: unknown) => void; integer: boolean }) {
  const min = schema.minimum ?? schema.exclusiveMinimum;
  const max = schema.maximum ?? schema.exclusiveMaximum;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (typeof value === "number" ? String(value) : "");
  const parsed = shown === "" ? undefined : Number(shown);
  const bad =
    parsed !== undefined &&
    (Number.isNaN(parsed) ||
      (integer && !Number.isInteger(parsed)) ||
      (min !== undefined && (schema.exclusiveMinimum !== undefined ? parsed <= min : parsed < min)) ||
      (max !== undefined && (schema.exclusiveMaximum !== undefined ? parsed >= max : parsed > max)));
  return (
    <>
      <input
        id={id}
        type="number"
        step={integer ? 1 : "any"}
        min={min}
        max={max}
        className={bad ? "bad" : ""}
        placeholder={schema.default !== undefined && schema.default !== null ? String(schema.default) : ""}
        value={shown}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const number = Number(text);
          if (text === "") onChange(undefined);
          else if (!Number.isNaN(number)) onChange(number);
        }}
        onBlur={() => setDraft(null)}
      />
      {bad && (
        <div className="field-error">
          {integer ? "Whole number" : "Number"}
          {min !== undefined ? `, ${schema.exclusiveMinimum !== undefined ? ">" : "≥"} ${min}` : ""}
          {max !== undefined ? `, ${schema.exclusiveMaximum !== undefined ? "<" : "≤"} ${max}` : ""}
        </div>
      )}
    </>
  );
}

function parseLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(trimmed)) return Number(trimmed);
  return text;
}

function LooseInput({ id, value, onChange }: { id?: string; value: unknown; onChange: (v: unknown) => void }) {
  return <input id={id} value={display(value)} onChange={(e) => onChange(parseLoose(e.target.value))} />;
}

function ColumnSelect({ id, schema, columns, value, onChange }: { id: string; schema: JsonSchema; columns: ColumnSchema[] | null; value: unknown; onChange: (v: unknown) => void }) {
  if (!columns) {
    return <input id={id} placeholder="Connect an input to pick a column" value={display(value)} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
  const options = filterColumns(columns, schema);
  const missing = typeof value === "string" && !options.some((c) => c.name === value);
  return (
    <>
      <select id={id} value={display(value)} onChange={(e) => onChange(e.target.value || undefined)} className={missing ? "bad" : ""}>
        <option value="">{schema.default ? `Default (${String(schema.default)})` : "—"}</option>
        {missing && <option value={String(value)}>{String(value)} (not in input)</option>}
        {options.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {humanise(c.semantic)}
            {c.role !== "feature" ? ` · ${c.role}` : ""}
          </option>
        ))}
      </select>
      {missing && <div className="field-error">'{String(value)}' is not a column of the input</div>}
    </>
  );
}

function ColumnMulti({ schema, columns, value, onChange }: { schema: JsonSchema; columns: ColumnSchema[]; value: unknown; onChange: (v: unknown) => void }) {
  const [filter, setFilter] = useState("");
  const options = useMemo(() => filterColumns(columns, schema), [columns, schema]);
  const selected = new Set(Array.isArray(value) ? value.map(String) : []);
  const shown = options.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
  const unknown = [...selected].filter((name) => !options.some((c) => c.name === name));
  const toggle = (name: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    const ordered = [...options.map((c) => c.name).filter((n) => next.has(n)), ...unknown.filter((n) => next.has(n))];
    onChange(ordered.length ? ordered : undefined);
  };
  return (
    <div className="column-multi">
      <div className="column-multi-bar">
        {options.length > 8 && <input placeholder="Filter columns…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="dim small">{selected.size ? `${selected.size} selected` : "none selected (node default)"}</span>
        <button className="link-button small" onClick={() => onChange(options.map((c) => c.name))}>all</button>
        <button className="link-button small" onClick={() => onChange(undefined)}>clear</button>
      </div>
      <div className="column-list">
        {shown.map((c) => (
          <label key={c.name} className="column-option">
            <input type="checkbox" checked={selected.has(c.name)} onChange={(e) => toggle(c.name, e.target.checked)} />
            <span className="mono">{c.name}</span>
            <span className="dim small">{humanise(c.semantic)}</span>
          </label>
        ))}
        {unknown.map((name) => (
          <label key={name} className="column-option bad">
            <input type="checkbox" checked onChange={() => toggle(name, false)} />
            <span className="mono">{name}</span>
            <span className="small">not in input</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function MapEditor({ valueSchema, root, value, onChange, columns }: { valueSchema: JsonSchema; root: JsonSchema; value: unknown; onChange: (v: unknown) => void; columns: ColumnSchema[] | null }) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const [newKey, setNewKey] = useState("");
  const commit = (next: [string, unknown][]) => onChange(next.length ? Object.fromEntries(next) : undefined);
  const { inner } = unwrapNullable(valueSchema, root);
  const renderValue = (current: unknown, update: (v: unknown) => void) =>
    inner.enum ? (
      <select value={display(current)} onChange={(e) => update(e.target.value)}>
        {inner.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {humanise(String(o))}
          </option>
        ))}
      </select>
    ) : (
      <LooseInput value={current} onChange={(v) => update(v ?? "")} />
    );
  const keyOptions = columns?.map((c) => c.name).filter((name) => !entries.some(([k]) => k === name));
  return (
    <div className="map-editor">
      {entries.map(([key, current], i) => (
        <div className="map-row" key={key}>
          <span className="mono map-key" title={key}>
            {key}
          </span>
          {renderValue(current, (v) => commit(entries.map((entry, j) => (j === i ? [key, v] : entry))))}
          <button className="link-button" aria-label={`Remove ${key}`} onClick={() => commit(entries.filter((_, j) => j !== i))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <div className="map-row">
        {keyOptions ? (
          <select value={newKey} onChange={(e) => setNewKey(e.target.value)} aria-label="Key">
            <option value="">Add column…</option>
            {keyOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <input placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} aria-label="Key" />
        )}
        <button
          disabled={!newKey || entries.some(([k]) => k === newKey)}
          onClick={() => {
            commit([...entries, [newKey, inner.enum ? inner.enum[0] : ""]]);
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function JsonEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <textarea
        className="json-editor"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed: unknown = JSON.parse(e.target.value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("params must be a JSON object");
            setError(null);
            onChange(parsed as Record<string, unknown>);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {error && <div className="field-error">{error}</div>}
    </>
  );
}

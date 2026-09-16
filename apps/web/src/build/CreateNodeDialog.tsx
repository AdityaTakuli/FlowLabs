import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { PURPOSE_ICON, type BuildCatalogue, type Purpose, type Technique } from "./types";

/** Step 1: what is this node for? Step 2: pick a technique (with its code example). */
export function CreateNodeDialog({
  catalogue,
  initialPurpose,
  task,
  onAdd,
  onClose,
}: {
  catalogue: BuildCatalogue;
  initialPurpose: string | null;
  task: "classification" | "regression" | null;
  onAdd: (technique: Technique) => void;
  onClose: () => void;
}) {
  const [purposeId, setPurposeId] = useState<string | null>(initialPurpose);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const purpose = catalogue.purposes.find((p) => p.id === purposeId) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => search.current?.focus(), [purposeId]);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool: { technique: Technique; purpose: Purpose }[] = purpose
      ? purpose.snippets.map((technique) => ({ technique, purpose }))
      : words.length
        ? catalogue.purposes.flatMap((p) => p.snippets.map((technique) => ({ technique, purpose: p })))
        : [];
    return pool.filter(({ technique }) => {
      const text = `${technique.title} ${technique.description} ${technique.tags.join(" ")} ${technique.group} ${technique.id}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [catalogue, purpose, query]);

  const groups = useMemo(() => {
    const grouped = new Map<string, { technique: Technique; purpose: Purpose }[]>();
    for (const item of matches) {
      const key = purpose ? item.technique.group || purpose.title : `${item.purpose.title}${item.technique.group ? ` · ${item.technique.group}` : ""}`;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [matches, purpose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal create-node" role="dialog" aria-label="Create node" onMouseDown={(e) => e.stopPropagation()}>
        <header className="create-node-head">
          {purpose ? (
            <button className="link-button" onClick={() => (setPurposeId(null), setQuery(""))}>
              <Icon name="chevronRight" size={11} className="flip" /> All purposes
            </button>
          ) : (
            <span className="create-step">Step 1 of 2</span>
          )}
          <h2>{purpose ? purpose.title : "What is this node for?"}</h2>
          <div className="spacer" />
          <button className="link-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="create-search">
          <Icon name="search" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={purpose ? `Search ${purpose.snippets.length} techniques…` : "Search every technique (e.g. scale, svm, pytorch, impute)…"}
            aria-label="Search techniques"
          />
        </div>

        {!purpose && !query.trim() ? (
          <div className="purpose-grid">
            {catalogue.purposes.map((p) => (
              <button key={p.id} className="purpose-card" onClick={() => setPurposeId(p.id)}>
                <Icon name={PURPOSE_ICON[p.id] ?? "dot"} size={18} />
                <span className="purpose-title">{p.title}</span>
                <span className="purpose-question">{p.question}</span>
                <span className="purpose-count">{p.snippets.length} techniques</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="technique-list">
            {!matches.length && <div className="dim panel">No technique matches “{query}”.</div>}
            {groups.map(([group, items]) => (
              <section key={group}>
                {group && <h3>{group}</h3>}
                {items.map(({ technique }) => {
                  const mismatch = technique.task !== null && task !== null && technique.task !== task;
                  const expanded = open === technique.id;
                  return (
                    <article key={technique.id} className={`technique ${mismatch ? "mismatch" : ""}`}>
                      <div className="technique-head">
                        <div className="technique-text">
                          <span className="technique-title">{technique.title}</span>
                          {technique.task && <span className="chip">{technique.task}</span>}
                          {mismatch && <span className="chip warn">target is {task}</span>}
                          <span className="technique-description">{technique.description}</span>
                        </div>
                        <button onClick={() => setOpen(expanded ? null : technique.id)} aria-expanded={expanded}>
                          {expanded ? "Hide code" : "Show code"}
                        </button>
                        <button className="primary" onClick={() => onAdd(technique)}>
                          Add node
                        </button>
                      </div>
                      {expanded && (
                        <>
                          {Object.keys(technique.params).length > 0 && (
                            <div className="technique-params small dim">
                              Settings: {Object.entries(technique.params).map(([name, spec]) => `${name} (${spec.type}${spec.default !== null && spec.default !== undefined ? ` = ${JSON.stringify(spec.default)}` : ""})`).join(", ")}
                            </div>
                          )}
                          <pre className="technique-code">{technique.example}</pre>
                        </>
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

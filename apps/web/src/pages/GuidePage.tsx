// The user guide, inside the app: topics on the left (with search), the page in the middle, and
// its outline on the right. Step and model reference comes live from the engine's catalogue.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { headings, Markdown, plain, slug, type Heading } from "../components/Markdown";
import { SectionNav, TopBar } from "../components/TopBar";
import { findTopic, TOPICS, type Topic } from "../guide/topics";
import type { AlgoDef, Catalogue, OpDef, Param } from "../types";

function defaultText(param: Param): string {
  const value = param.default;
  if (param.type === "code") return "template";
  if (param.options?.length) return String(param.options.find((o) => o.value === value)?.label ?? value ?? "");
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined || value === "") return "–";
  return String(value);
}

function rangeText(param: Param): string {
  if (param.options?.length && param.type === "select") return param.options.map((o) => o.label).join(", ");
  if (param.min !== undefined && param.max !== undefined) return `${param.min} to ${param.max}`;
  return "";
}

function Params({ params }: { params: Param[] }) {
  if (!params.length) return <p className="faint small">No settings.</p>;
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Default</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={p.name}>
              <td>
                <b>{p.label}</b>
              </td>
              <td className="dim">{defaultText(p)}</td>
              <td>
                {p.help || ""}
                {rangeText(p) && <div className="faint tiny">{rangeText(p)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STAGES: [keyof Pick<Catalogue, "clean" | "rows" | "transform">, string, string][] = [
  ["clean", "Clean steps", "Run on the whole table, and on new data when predicting."],
  ["rows", "Training-set steps", "Run on training rows only. Test rows never pass through them."],
  ["transform", "Transform steps", "Learn from training rows, then apply to every row."],
];

function referenceHeadings(catalogue: Catalogue): Heading[] {
  return [
    ...STAGES.map(([, title]) => ({ level: 2, text: title, id: slug(title) })),
    { level: 2, text: "Models", id: "models" },
    { level: 2, text: "Image models", id: "image-models" },
  ].filter((h) => h.id !== "image-models" || catalogue.image_models.length > 0);
}

function referenceText(catalogue: Catalogue): string {
  const ops = [...catalogue.clean, ...catalogue.rows, ...catalogue.transform];
  const algos = [...catalogue.models, ...catalogue.image_models];
  return [...ops, ...algos].map((o) => `${o.label} ${o.description} ${o.params.map((p) => `${p.label} ${p.help ?? ""}`).join(" ")}`).join("\n");
}

function Reference({ catalogue }: { catalogue: Catalogue }) {
  const op = (o: OpDef) => (
    <section key={o.id} className="ref-item">
      <h3 id={slug(o.label)}>
        {o.label} <span className="badge">{o.group}</span>
      </h3>
      <p>{o.description}</p>
      <Params params={o.params} />
    </section>
  );
  const algo = (a: AlgoDef) => (
    <section key={a.id} className="ref-item">
      <h3 id={slug(a.label)}>
        {a.label} <span className="badge">{a.family}</span>
        {a.tasks.map((t) => (
          <span key={t} className="badge solid">
            {t}
          </span>
        ))}
        {!a.available && a.needs && <span className="badge warning">needs {a.needs}</span>}
      </h3>
      <p>{a.description}</p>
      <Params params={a.params} />
    </section>
  );
  return (
    <div className="markdown">
      <h1>Steps and models</h1>
      <p className="guide-lead">
        Every step and model FlowLabs offers, with each setting and its default. This page is generated from the engine you are connected to, so it always matches your
        version. A model marked <i>needs</i> requires a package that engine does not have.
      </p>
      {STAGES.map(([stage, title, about]) => (
        <div key={stage}>
          <h2 id={slug(title)}>{title}</h2>
          <p className="dim">{about}</p>
          {catalogue[stage].map(op)}
        </div>
      ))}
      <h2 id="models">Models</h2>
      <p className="dim">Add them on the Pipeline page. Every setting can also be tuned automatically.</p>
      {catalogue.models.map(algo)}
      {catalogue.image_models.length > 0 && (
        <>
          <h2 id="image-models">Image models</h2>
          {catalogue.image_models.map(algo)}
        </>
      )}
    </div>
  );
}

interface Hit {
  topic: Topic;
  snippet: string;
  heading?: Heading;
}

function search(query: string, catalogue: Catalogue): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: (Hit & { score: number })[] = [];
  for (const topic of TOPICS) {
    const text = topic.id === "reference" ? referenceText(catalogue) : topic.text;
    const lower = plain(text).toLowerCase();
    if (!words.every((w) => lower.includes(w) || topic.title.toLowerCase().includes(w))) continue;
    const position = lower.indexOf(words[0]!);
    const start = Math.max(0, position - 60);
    const snippet = (start > 0 ? "…" : "") + plain(text).slice(start, position + 110).replace(/\s+/g, " ").replace(/^#+ /, "") + "…";
    // the section the first match is in
    let heading: Heading | undefined;
    if (topic.id !== "reference") {
      const before = text.slice(0, text.toLowerCase().indexOf(words[0]!));
      const titles = headings(before);
      heading = titles.at(-1);
    }
    const score = words.reduce((s, w) => s + (topic.title.toLowerCase().includes(w) ? 10 : 0) + lower.split(w).length - 1, 0);
    hits.push({ topic, snippet, heading, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function highlight(text: string, query: string): ReactNode {
  const words = query.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

export function GuidePage({ topic: topicId, goHome, openTopic }: { topic?: string; goHome: () => void; openTopic: (id: string) => void }) {
  const { catalogue } = useApp();
  const topic = findTopic(topicId);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const article = useRef<HTMLDivElement>(null);
  const outline = useMemo(() => (topic.id === "reference" ? referenceHeadings(catalogue) : headings(topic.text)), [topic, catalogue]);
  const hits = useMemo(() => search(query, catalogue), [query, catalogue]);
  const index = TOPICS.indexOf(topic);
  const previous = TOPICS[index - 1];
  const next = TOPICS[index + 1];

  const go = (href: string) => {
    const [id, hash] = href.split("#");
    setAnchor(hash ?? null);
    if (id && id !== topic.id) openTopic(id);
    else if (hash) document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // after a topic opens: go to the anchor asked for, or the top
  useEffect(() => {
    const scroller = article.current?.closest(".guide-main");
    const timer = setTimeout(() => {
      const target = anchor ? document.getElementById(anchor) : null;
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else scroller?.scrollTo({ top: 0 });
    }, 60);
    return () => clearTimeout(timer);
  }, [topic.id, anchor]);

  // the outline follows the reading position
  useEffect(() => {
    const scroller = article.current?.closest(".guide-main");
    if (!scroller) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top + 90;
      let current: string | null = outline[0]?.id ?? null;
      for (const h of outline) {
        const element = document.getElementById(h.id);
        if (element && element.getBoundingClientRect().top <= top) current = h.id;
      }
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [outline, topic.id]);

  const groups = TOPICS.reduce<Record<string, Topic[]>>((all, t) => ({ ...all, [t.group]: [...(all[t.group] ?? []), t] }), {});
  return (
    <div className="shell">
      <TopBar onHome={goHome}>
        <SectionNav current="guide" onProjects={goHome} onGuide={() => undefined} />
      </TopBar>
      <div className="guide-layout">
        <aside className="guide-side" aria-label="Guide topics">
          <label className="guide-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              placeholder="Search the guide"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hits[0]) {
                  go(`${hits[0].topic.id}${hits[0].heading ? `#${hits[0].heading.id}` : ""}`);
                  setQuery("");
                }
                if (e.key === "Escape") setQuery("");
              }}
              aria-label="Search the guide"
            />
          </label>
          {query ? (
            <div className="guide-hits">
              {hits.length === 0 && <p className="faint small guide-empty">Nothing matches “{query}”.</p>}
              {hits.map((hit) => (
                <button
                  key={hit.topic.id}
                  className="guide-hit"
                  onClick={() => {
                    go(`${hit.topic.id}${hit.heading ? `#${hit.heading.id}` : ""}`);
                    setQuery("");
                  }}
                >
                  <b>{hit.topic.title}</b>
                  {hit.heading && <span className="faint tiny">{hit.heading.text}</span>}
                  <span className="dim tiny">{highlight(hit.snippet, query)}</span>
                </button>
              ))}
            </div>
          ) : (
            Object.entries(groups).map(([group, topics]) => (
              <nav key={group} className="guide-group" aria-label={group}>
                <h3>{group}</h3>
                {topics.map((t) => (
                  <button key={t.id} className={t.id === topic.id ? "active" : ""} aria-current={t.id === topic.id ? "page" : undefined} onClick={() => go(t.id)}>
                    {t.id === topic.id && <motion.span layoutId="guide-pill" className="guide-pill" transition={{ type: "spring", stiffness: 480, damping: 38 }} />}
                    {t.title}
                  </button>
                ))}
              </nav>
            ))
          )}
        </aside>
        <main className="guide-main">
          <AnimatePresence mode="wait">
            <motion.article
              key={topic.id}
              ref={article}
              className="guide-article"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="guide-kicker">{topic.group}</div>
              {topic.id === "reference" ? <Reference catalogue={catalogue} /> : <Markdown text={topic.text} go={go} className="guide-text" />}
              <nav className="guide-pager" aria-label="More topics">
                {previous ? (
                  <button onClick={() => go(previous.id)}>
                    <span className="faint tiny">Previous</span>
                    <b>
                      <Icon name="arrowLeft" size={13} /> {previous.title}
                    </b>
                  </button>
                ) : (
                  <span />
                )}
                {next && (
                  <button className="next" onClick={() => go(next.id)}>
                    <span className="faint tiny">Next</span>
                    <b>
                      {next.title} <Icon name="arrowRight" size={13} />
                    </b>
                  </button>
                )}
              </nav>
            </motion.article>
          </AnimatePresence>
        </main>
        <aside className="guide-outline" aria-label="On this page">
          {outline.length > 0 && (
            <>
              <h3>On this page</h3>
              {outline.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.id}`}
                  className={`${h.level === 3 ? "sub" : ""} ${active === h.id ? "active" : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {h.text}
                </a>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

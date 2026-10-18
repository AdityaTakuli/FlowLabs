// Markdown for the guide, release notes and model cards: headings with anchors, paragraphs, nested
// lists, tables, fenced code with a copy button, callouts (> ...), links, `code`, **bold**, *italic*
// and <kbd>keys</kbd>. Links written guide:topic#anchor open that guide page.
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>|[`*_]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** The ## and ### headings of a page, for its outline. */
export function headings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = !fenced && /^(#{2,3}) (.+)$/.exec(line);
    if (match) out.push({ level: match[1]!.length, text: plain(match[2]!), id: slug(match[2]!) });
  }
  return out;
}

/** Text without Markdown, for search. */
export function plain(text: string): string {
  return text
    .replace(/<\/?kbd>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+ |^> ?|\n#+ /gm, (m) => (m.startsWith("\n") ? "\n" : ""))
    .replace(/[`*]/g, "");
}

type Go = (href: string) => void;

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\)|<kbd>[^<]+<\/kbd>)/g;

function inline(text: string, go?: Go): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <b key={i}>{inline(part.slice(2, -2), go)}</b>;
    if (part.startsWith("<kbd>")) return <kbd key={i}>{part.slice(5, -6)}</kbd>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{inline(part.slice(1, -1), go)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      if (href!.startsWith("guide:") && go) {
        return (
          <a
            key={i}
            href={`?page=guide&topic=${href!.slice(6).split("#")[0]}`}
            onClick={(event) => {
              event.preventDefault();
              go(href!.slice(6));
            }}
          >
            {inline(label!, go)}
          </a>
        );
      }
      return (
        <a key={i} href={href} target="_blank" rel="noreferrer">
          {inline(label!, go)}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language || "text"}</span>
        <button
          className="ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const LIST = /^(\s*)([-*]|\d+\.) (.*)$/;
const BLOCK_START = /^(#{1,3} |```|\||> ?)/;

function blocks(lines: string[], go: Go | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `${keyBase}-${i}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      out.push(
        <Tag key={key()} id={slug(heading[2]!)}>
          {inline(heading[2]!, go)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(<CodeBlock key={key()} code={code.join("\n")} language={language} />);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        if (!/^\|\s*:?-/.test(lines[i]!)) rows.push(lines[i]!.split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push(
        <div className="md-table" key={key()}>
          <table>
            <thead>
              <tr>{rows[0]?.map((c, j) => <th key={j}>{inline(c, go)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, go)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^> ?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^> ?/, ""));
      out.push(
        <aside className="md-callout" key={key()}>
          {blocks(quote, go, key())}
        </aside>,
      );
      continue;
    }
    const item = LIST.exec(line);
    if (item && item[1] === "") {
      const ordered = /\d/.test(item[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const marker = LIST.exec(current);
        if (marker && marker[1] === "") {
          items.push([marker[3]!]);
          i++;
        } else if (current.startsWith("  ") || (!current.trim() && i + 1 < lines.length && lines[i + 1]!.startsWith("  "))) {
          items.at(-1)!.push(current.replace(/^ {2,3}/, ""));
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key()}>
          {items.map((content, k) => {
            const tight = content.length === 1;
            return <li key={k}>{tight ? inline(content[0]!, go) : blocks(content, go, `${key()}-${k}`)}</li>;
          })}
        </List>,
      );
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!) && !(LIST.exec(lines[i]!)?.[1] === "")) paragraph.push(lines[i++]!);
    out.push(<p key={key()}>{inline(paragraph.join(" "), go)}</p>);
  }
  return out;
}

export function Markdown({ text, go, className = "" }: { text: string; go?: Go; className?: string }) {
  return <div className={`markdown ${className}`}>{blocks(text.replace(/\r/g, "").split("\n"), go, "md")}</div>;
}

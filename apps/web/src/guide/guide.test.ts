import { describe, expect, it } from "vitest";
import { headings, plain, slug } from "../components/Markdown";
import { findTopic, TOPICS } from "./topics";

describe("the guide", () => {
  it("has a title and text for every written topic", () => {
    for (const topic of TOPICS.filter((t) => t.id !== "reference")) {
      expect(topic.title, topic.id).not.toBe(topic.id);
      expect(topic.text.length, topic.id).toBeGreaterThan(500);
      expect(topic.summary, topic.id).not.toBe("");
    }
  });

  it("links only to topics and sections that exist", () => {
    const ids = new Set(TOPICS.map((t) => t.id));
    for (const topic of TOPICS) {
      for (const [, target] of topic.text.matchAll(/\]\(guide:([^)]+)\)/g)) {
        const [id, anchor] = target!.split("#");
        expect(ids.has(id!), `${topic.id} links to ${target}`).toBe(true);
        if (anchor) expect(headings(findTopic(id).text).map((h) => h.id), `${topic.id} links to ${target}`).toContain(anchor);
      }
    }
  });

  it("makes anchors and plain text the way links expect", () => {
    expect(slug("Keep a result as a dataset")).toBe("keep-a-result-as-a-dataset");
    expect(slug("Use it from `Python`")).toBe("use-it-from-python");
    expect(plain("Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in [SQL](guide:sql)")).toBe("Press Ctrl+Enter in SQL");
    expect(plain("text\n### Read-only\n> **Tip.** ok")).toBe("text\nRead-only\nTip. ok");
    expect(headings("## A\n```\n## not a heading\n```\n### B").map((h) => h.id)).toEqual(["a", "b"]);
  });
});

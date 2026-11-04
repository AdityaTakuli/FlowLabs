// Drawing a sheet on a canvas: cells with their formats, fonts, fills, borders and text overflow,
// gridlines, headers, frozen panes, the selection and the fill handle.
import { type Area, colName, key, keyCol, keyRow } from "../engine/address";
import { isError } from "../engine/values";
import type { BorderEdge, Sheet, Style, Workbook } from "../engine/workbook";
import { conditionalLooks, TABLE_STYLES, validationAt, type CondLook } from "../engine/features";
import { cellRect, HEADER_H, HEADER_W, type Layout } from "./layout";

export interface Theme {
  bg: string;
  grid: string;
  text: string;
  dim: string;
  header: string;
  headerText: string;
  headerActive: string;
  headerActiveText: string;
  accent: string;
  accentSoft: string;
  frozen: string;
  error: string;
}

export function readTheme(el: HTMLElement): Theme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--sh-bg", "#ffffff"),
    grid: v("--sh-grid", "#e3e3e8"),
    text: v("--sh-text", "#1d1d1f"),
    dim: v("--sh-dim", "#86868b"),
    header: v("--sh-header", "#f5f5f7"),
    headerText: v("--sh-header-text", "#6e6e73"),
    headerActive: v("--sh-header-active", "#e8e8ed"),
    headerActiveText: v("--sh-header-active-text", "#1d1d1f"),
    accent: v("--sh-accent", "#0a84ff"),
    accentSoft: v("--sh-accent-soft", "rgba(10,132,255,0.12)"),
    frozen: v("--sh-frozen", "#c7c7cc"),
    error: v("--sh-error", "#ff3b30"),
  };
}

export interface Selection {
  active: { row: number; col: number };
  ranges: Area[];
}

export interface Overlay {
  selection: Selection;
  /** References a formula being edited points at, in their colours. */
  refs: { area: Area; color: string }[];
  /** The area copied or cut (marching ants). */
  copied: Area | null;
  antsOffset: number;
  /** The fill handle being dragged out to. */
  fillTo: Area | null;
  /** The cell being edited (its text is drawn by the editor). */
  editing: { row: number; col: number } | null;
  /** Show formulas instead of values (Ctrl+`). */
  showFormulas: boolean;
  /** Cells found by Find. */
  found: { row: number; col: number } | null;
  /** Cells whose values break their validation rule (Circle Invalid Data). */
  invalid?: { row: number; col: number }[];
}

/** Where a filter button sits in a header cell (also used to hit-test clicks on it). */
export function filterButton(box: { x: number; y: number; w: number; h: number }) {
  const size = Math.min(18, box.h - 4);
  return { x: box.x + box.w - size - 3, y: box.y + (box.h - size) / 2, w: size, h: size };
}

export const REF_COLORS = ["#0a84ff", "#ff375f", "#30d158", "#bf5af2", "#ff9f0a", "#64d2ff", "#ac8e68", "#5e5ce6"];

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

function fontOf(style: Style, zoom: number): string {
  const size = (style.size ?? 11) * (13 / 11) * zoom;
  return `${style.italic ? "italic " : ""}${style.bold ? "600 " : ""}${size.toFixed(1)}px ${style.font ? `"${style.font}", ` : ""}${FONT}`;
}

/** Text on a coloured fill: dark on light fills, light on dark ones (so fills read in dark mode too). */
function onFill(fill: string, fallback: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(fill.trim());
  if (!m) return fallback;
  const n = parseInt(m[1]!, 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#1d1d1f" : "#f5f5f7";
}

function borderWidth(edge: BorderEdge): number {
  return edge.style === "medium" ? 2 : edge.style === "thick" ? 3 : 1;
}

function strokeEdge(ctx: CanvasRenderingContext2D, edge: BorderEdge, x1: number, y1: number, x2: number, y2: number, fallback: string) {
  ctx.save();
  ctx.strokeStyle = edge.color ?? fallback;
  ctx.lineWidth = borderWidth(edge);
  if (edge.style === "dashed") ctx.setLineDash([4, 2]);
  if (edge.style === "dotted") ctx.setLineDash([1, 2]);
  ctx.beginPath();
  if (edge.style === "double") {
    const dx = y1 === y2 ? 0 : 1.5;
    const dy = y1 === y2 ? 1.5 : 0;
    ctx.moveTo(x1 - dx, y1 - dy);
    ctx.lineTo(x2 - dx, y2 - dy);
    ctx.moveTo(x1 + dx, y1 + dy);
    ctx.lineTo(x2 + dx, y2 + dy);
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  ctx.restore();
}

/** Lines of text broken to fit a width (wrap text). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (ctx.measureText(next).width > width && line.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
        while (ctx.measureText(line).width > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

interface Region {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
  clip: { x: number; y: number; w: number; h: number };
}

export function draw(
  canvas: HTMLCanvasElement,
  wb: Workbook,
  sheet: Sheet,
  layout: Layout,
  scrollX: number,
  scrollY: number,
  width: number,
  height: number,
  theme: Theme,
  overlay: Overlay,
  zoom: number,
) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "middle";

  const hw = HEADER_W;
  const hh = HEADER_H;
  const { rows, cols } = layout;
  // visible rows and columns in the scrolled part
  const firstRow = rows.at(layout.frozenH + scrollY);
  const lastRow = rows.at(layout.frozenH + scrollY + Math.max(0, height - hh - layout.frozenH));
  const firstCol = cols.at(layout.frozenW + scrollX);
  const lastCol = cols.at(layout.frozenW + scrollX + Math.max(0, width - hw - layout.frozenW));
  const fr = layout.freezeRows;
  const fc = layout.freezeCols;
  const mainClip = { x: hw + layout.frozenW, y: hh + layout.frozenH, w: width - hw - layout.frozenW, h: height - hh - layout.frozenH };
  const regions: Region[] = [{ r1: firstRow, r2: lastRow, c1: firstCol, c2: lastCol, clip: mainClip }];
  if (fr) regions.push({ r1: 0, r2: fr - 1, c1: firstCol, c2: lastCol, clip: { x: hw + layout.frozenW, y: hh, w: mainClip.w, h: layout.frozenH } });
  if (fc) regions.push({ r1: firstRow, r2: lastRow, c1: 0, c2: fc - 1, clip: { x: hw, y: hh + layout.frozenH, w: layout.frozenW, h: mainClip.h } });
  if (fr && fc) regions.push({ r1: 0, r2: fr - 1, c1: 0, c2: fc - 1, clip: { x: hw, y: hh, w: layout.frozenW, h: layout.frozenH } });

  const rect = (r: number, c: number, rs = 1, cs = 1) => cellRect(layout, r, c, scrollX, scrollY, rs, cs);
  // conditional formats for everything in view (frozen parts included)
  const view = { r1: Math.min(firstRow, 0), c1: Math.min(firstCol, 0), r2: lastRow, c2: lastCol };
  let looks: Map<number, CondLook> = new Map();
  if (sheet.conditionals.length) {
    try {
      looks = conditionalLooks(wb, sheet, { ...view, r1: fr ? 0 : firstRow, c1: fc ? 0 : firstCol });
    } catch {
      looks = new Map();
    }
  }
  const tableLook = (r: number, c: number): Partial<Style> | null => {
    for (const t of sheet.tables) {
      const a = t.area;
      if (r < a.r1 || r > a.r2 || c < a.c1 || c > a.c2) continue;
      const pal = TABLE_STYLES[t.style] ?? TABLE_STYLES.blue!;
      if (r === a.r1 && t.header) return { fill: pal.header, color: pal.headerText, bold: true };
      if (t.totals && r === a.r2) return { bold: true, top: { style: "double", color: pal.header } };
      // bands count visible rows, as Excel's do
      let n = 0;
      for (let i = a.r1 + 1; i < r; i++) if (!sheet.hiddenRows.has(i) && !sheet.filterHidden.has(i)) n++;
      return t.banded && n % 2 === 0 ? { fill: pal.band } : {};
    }
    return null;
  };
  const mergeIndex = new Map<number, Area>();
  for (const m of sheet.merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) mergeIndex.set(key(r, c), m);

  for (const region of regions) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.clip.x, region.clip.y, region.clip.w, region.clip.h);
    ctx.clip();
    drawRegion(region);
    ctx.restore();
  }

  function cellStyle(r: number, c: number): Style {
    const own = wb.style(sheet.cells.get(key(r, c))?.s);
    const table = sheet.tables.length ? tableLook(r, c) : null;
    const look = looks.get(key(r, c));
    if (!table && !look?.style) return own;
    // a table's look sits under the cell's own format; conditional formats sit on top
    const merged: Style = { ...(table ?? {}), ...own, ...(look?.style ?? {}) };
    if (table?.fill && !own.fill && !look?.style?.fill) merged.fill = table.fill;
    if (table?.color && !own.color && !look?.style?.color) merged.color = table.color;
    return merged;
  }

  function drawRegion(region: Region) {
    const { r1, r2, c1, c2 } = region;
    // fills (a cell's own, its table's, its conditional format's)
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        if (!sheet.tables.length && !looks.size && !sheet.cells.get(key(r, c))?.s) continue;
        const st = cellStyle(r, c);
        if (!st.fill) continue;
        const m = mergeIndex.get(key(r, c));
        if (m && (m.r1 !== r || m.c1 !== c)) continue;
        const box = m ? rect(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1) : rect(r, c);
        ctx.fillStyle = st.fill;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
    // gridlines (not across merged cells)
    if (sheet.showGrid) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = c1; c <= c2 + 1; c++) {
        if (cols.size(c - 1) === 0 && c > 0) continue;
        const x = Math.round(rect(0, c).x) + 0.5;
        ctx.moveTo(x, region.clip.y);
        ctx.lineTo(x, region.clip.y + region.clip.h);
      }
      for (let r = r1; r <= r2 + 1; r++) {
        if (rows.size(r - 1) === 0 && r > 0) continue;
        const y = Math.round(rect(r, 0).y) + 0.5;
        ctx.moveTo(region.clip.x, y);
        ctx.lineTo(region.clip.x + region.clip.w, y);
      }
      ctx.stroke();
      // merged cells cover their inner gridlines
      for (const m of sheet.merges) {
        if (m.r2 < r1 || m.r1 > r2 || m.c2 < c1 || m.c1 > c2) continue;
        const box = rect(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1);
        const st = cellStyle(m.r1, m.c1);
        ctx.fillStyle = st.fill ?? theme.bg;
        ctx.fillRect(box.x + 1, box.y + 1, box.w - 1, box.h - 1);
      }
    }
    // values
    for (let r = r1; r <= r2; r++) {
      const rh = rows.size(r);
      if (rh === 0) continue;
      for (let c = c1; c <= c2; c++) {
        if (cols.size(c) === 0) continue;
        const k = key(r, c);
        const m = mergeIndex.get(k);
        if (m && (m.r1 !== r || m.c1 !== c)) continue;
        if (overlay.editing && overlay.editing.row === r && overlay.editing.col === c) continue;
        const cell = sheet.cells.get(k);
        const spilled = !cell && sheet.spillOf.has(k);
        const look = looks.get(k);
        if (!cell && !spilled && !look) continue;
        const st = cellStyle(r, c);
        let text: string;
        let color: string | undefined;
        let value: unknown;
        if (overlay.showFormulas && cell?.f !== undefined) {
          text = "=" + cell.f;
          value = text;
        } else {
          const shown = wb.display(sheet, r, c);
          text = shown.text;
          color = shown.color;
          value = shown.value;
        }
        const box = m ? rect(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1) : rect(r, c);
        if (look?.bar) {
          // a data bar, behind the text
          const grad = ctx.createLinearGradient(box.x, 0, box.x + box.w, 0);
          grad.addColorStop(0, look.bar.color);
          grad.addColorStop(1, look.bar.color + "33");
          ctx.fillStyle = grad;
          ctx.fillRect(box.x + 2, box.y + 3, Math.max(0, (box.w - 4) * look.bar.fill), box.h - 6);
        }
        if (look?.icon) drawIcon(look.icon.kind, look.icon.level, box.x + 4, box.y + box.h / 2);
        if (cell?.note) {
          ctx.fillStyle = theme.error;
          ctx.beginPath();
          ctx.moveTo(box.x + box.w - 6, box.y + 1);
          ctx.lineTo(box.x + box.w - 1, box.y + 1);
          ctx.lineTo(box.x + box.w - 1, box.y + 6);
          ctx.fill();
        }
        if (!text) continue;
        ctx.font = fontOf(st, zoom);
        ctx.fillStyle = color ?? st.color ?? (isError(value) ? theme.error : st.fill ? onFill(st.fill, theme.text) : theme.text);
        const pad = 4 * zoom + (st.indent ?? 0) * 9 * zoom + (look?.icon ? 14 : 0);
        const isNumber = typeof value === "number" && !overlay.showFormulas;
        const align = st.h ?? (isNumber ? "right" : typeof value === "boolean" || isError(value) ? "center" : "left");
        const vAlign = st.v ?? "bottom";
        if (st.wrap) {
          const lines = wrapLines(ctx, text, box.w - pad * 2);
          const lh = (st.size ?? 11) * 1.55 * zoom;
          const total = lines.length * lh;
          let y = vAlign === "top" ? box.y + lh / 2 + 2 : vAlign === "middle" ? box.y + (box.h - total) / 2 + lh / 2 : box.y + box.h - total + lh / 2 - 3;
          ctx.save();
          ctx.beginPath();
          ctx.rect(box.x, box.y, box.w, box.h);
          ctx.clip();
          for (const line of lines) {
            drawText(line, box.x, box.w, y, align, pad, st);
            y += lh;
          }
          ctx.restore();
          continue;
        }
        let shownText = text.split("\n")[0]!;
        const tw = ctx.measureText(shownText).width;
        const y = vAlign === "top" ? box.y + 10 * zoom : vAlign === "middle" ? box.y + box.h / 2 : box.y + box.h - 9 * zoom;
        let clipX = box.x;
        let clipW = box.w;
        if (tw + pad * 2 > box.w) {
          if (isNumber) {
            // numbers never spill into neighbours: they show ####, or fewer decimals in General
            shownText = "#".repeat(Math.max(1, Math.floor((box.w - pad) / ctx.measureText("#").width)));
          } else if (!m) {
            // text overflows into empty cells beside it
            const empty = (cc: number) => {
              const other = sheet.cells.get(key(r, cc));
              return !sheet.spillOf.has(key(r, cc)) && (!other || (other.v === null && other.f === undefined)) && !mergeIndex.has(key(r, cc));
            };
            if (align === "left" || align === "justify") {
              let cc = c + 1;
              let w = box.w;
              while (w < tw + pad * 2 && cc < c2 + 40 && empty(cc)) w += cols.size(cc++);
              clipW = w;
            } else if (align === "right") {
              let cc = c - 1;
              let w = box.w;
              while (w < tw + pad * 2 && cc >= 0 && empty(cc)) w += cols.size(cc--);
              clipX = box.x + box.w - w;
              clipW = w;
            } else {
              let w = box.w;
              let left = c - 1;
              let right = c + 1;
              while (w < tw + pad * 2 && (left >= 0 || right < c2 + 40)) {
                const okL = left >= 0 && empty(left) && empty(right);
                if (!okL) break;
                w += cols.size(left--) + cols.size(right++);
              }
              clipX = box.x - (w - box.w) / 2;
              clipW = w;
            }
          }
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX, box.y, clipW, box.h);
        ctx.clip();
        drawText(shownText, box.x, box.w, y, align, pad, st);
        ctx.restore();
      }
    }
    // borders
    for (let r = Math.max(0, r1 - 1); r <= r2 + 1; r++)
      for (let c = Math.max(0, c1 - 1); c <= c2 + 1; c++) {
        const cell = sheet.cells.get(key(r, c));
        if (!cell?.s && !sheet.tables.length && !looks.size) continue;
        const st = cellStyle(r, c);
        if (!st.top && !st.bottom && !st.left && !st.right) continue;
        const m = mergeIndex.get(key(r, c));
        const box = m ? rect(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1) : rect(r, c);
        const x1 = Math.round(box.x) + 0.5;
        const y1 = Math.round(box.y) + 0.5;
        const x2 = Math.round(box.x + box.w) + 0.5;
        const y2 = Math.round(box.y + box.h) + 0.5;
        if (st.top) strokeEdge(ctx, st.top, x1, y1, x2, y1, theme.text);
        if (st.bottom) strokeEdge(ctx, st.bottom, x1, y2, x2, y2, theme.text);
        if (st.left) strokeEdge(ctx, st.left, x1, y1, x1, y2, theme.text);
        if (st.right) strokeEdge(ctx, st.right, x2, y1, x2, y2, theme.text);
      }
    // a spilled array's edge, when the selection is in it
    const a = overlay.selection.active;
    const anchor = sheet.spills.has(key(a.row, a.col)) ? key(a.row, a.col) : sheet.spillOf.get(key(a.row, a.col));
    if (anchor !== undefined) {
      const area = sheet.spills.get(anchor);
      if (area) {
        const box = rect(area.r1, area.c1, area.r2 - area.r1 + 1, area.c2 - area.c1 + 1);
        ctx.save();
        ctx.strokeStyle = theme.accent;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.w) - 1, Math.round(box.h) - 1);
        ctx.restore();
      }
    }
    drawFilterButtons(region);
    drawSelection();
  }

  function drawFilterButtons(region: Region) {
    const f = sheet.filter;
    if (!f || f.area.r1 < region.r1 || f.area.r1 > region.r2) return;
    for (let c = Math.max(f.area.c1, region.c1); c <= Math.min(f.area.c2, region.c2); c++) {
      const b = filterButton(rect(f.area.r1, c));
      const active = Boolean(f.columns[c] && (f.columns[c]!.values || f.columns[c]!.cond || f.columns[c]!.top));
      ctx.fillStyle = theme.bg;
      ctx.strokeStyle = active ? theme.accent : theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, b.w - 1, b.h - 1, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = active ? theme.accent : theme.dim;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (active) {
        // a funnel: this column is filtered
        ctx.beginPath();
        ctx.moveTo(cx - 5, cy - 4);
        ctx.lineTo(cx + 5, cy - 4);
        ctx.lineTo(cx + 1, cy + 1);
        ctx.lineTo(cx + 1, cy + 5);
        ctx.lineTo(cx - 1, cy + 5);
        ctx.lineTo(cx - 1, cy + 1);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 2);
        ctx.lineTo(cx + 4, cy - 2);
        ctx.lineTo(cx, cy + 3);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function drawIcon(kind: string, level: number, x: number, y: number) {
    const colors = ["#e74c3c", "#f1c40f", "#27ae60"];
    ctx.save();
    ctx.fillStyle = colors[level]!;
    ctx.strokeStyle = colors[level]!;
    if (kind === "arrows") {
      ctx.lineWidth = 2;
      ctx.beginPath();
      const dir = level === 2 ? -1 : level === 0 ? 1 : 0;
      if (dir === 0) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + 9, y);
        ctx.moveTo(x + 6, y - 3);
        ctx.lineTo(x + 9, y);
        ctx.lineTo(x + 6, y + 3);
      } else {
        ctx.moveTo(x + 4.5, y + 5 * -dir);
        ctx.lineTo(x + 4.5, y - 5 * -dir);
        ctx.moveTo(x + 1, y + 1.5 * dir);
        ctx.lineTo(x + 4.5, y + 5 * dir);
        ctx.lineTo(x + 8, y + 1.5 * dir);
      }
      ctx.stroke();
    } else if (kind === "stars") {
      ctx.globalAlpha = 0.35 + level * 0.32;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? 2.2 : 5;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        ctx.lineTo(x + 5 + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      ctx.fill();
    } else if (kind === "flags") {
      ctx.fillRect(x + 1, y - 5, 1.5, 10);
      ctx.beginPath();
      ctx.moveTo(x + 2.5, y - 5);
      ctx.lineTo(x + 9, y - 2.5);
      ctx.lineTo(x + 2.5, y);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x + 5, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawText(text: string, x: number, w: number, y: number, align: string, pad: number, st: Style) {
    let tx: number;
    if (align === "right") {
      ctx.textAlign = "right";
      tx = x + w - pad;
    } else if (align === "center") {
      ctx.textAlign = "center";
      tx = x + w / 2;
    } else {
      ctx.textAlign = "left";
      tx = x + pad;
    }
    ctx.fillText(text, tx, y);
    if (st.underline || st.strike) {
      const tw = ctx.measureText(text).width;
      const left = align === "right" ? tx - tw : align === "center" ? tx - tw / 2 : tx;
      ctx.fillRect(left, st.strike ? y : y + 7 * zoom, tw, 1);
    }
  }

  function drawSelection() {
    const sel = overlay.selection;
    ctx.save();
    for (const area of sel.ranges) {
      const box = rect(area.r1, area.c1, area.r2 - area.r1 + 1, area.c2 - area.c1 + 1);
      if (area.r1 === area.r2 && area.c1 === area.c2 && sel.ranges.length === 1) continue;
      ctx.fillStyle = theme.accentSoft;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    // the active cell stays clear
    const am = sheet.merges.find((m) => sel.active.row >= m.r1 && sel.active.row <= m.r2 && sel.active.col >= m.c1 && sel.active.col <= m.c2);
    const active = am ? rect(am.r1, am.c1, am.r2 - am.r1 + 1, am.c2 - am.c1 + 1) : rect(sel.active.row, sel.active.col);
    if (sel.ranges.some((a) => a.r1 !== a.r2 || a.c1 !== a.c2) || sel.ranges.length > 1) {
      const st = cellStyle(sel.active.row, sel.active.col);
      ctx.fillStyle = st.fill ?? theme.bg;
      ctx.fillRect(active.x + 1, active.y + 1, active.w - 1, active.h - 1);
      // redraw its text over the cleared box
      if (!(overlay.editing && overlay.editing.row === sel.active.row && overlay.editing.col === sel.active.col)) {
        const shown = wb.display(sheet, sel.active.row, sel.active.col);
        if (shown.text) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(active.x, active.y, active.w, active.h);
          ctx.clip();
          ctx.font = fontOf(st, zoom);
          ctx.fillStyle = shown.color ?? st.color ?? (isError(shown.value) ? theme.error : st.fill ? onFill(st.fill, theme.text) : theme.text);
          const isNumber = typeof shown.value === "number";
          drawText(shown.text, active.x, active.w, st.v === "top" ? active.y + 10 * zoom : st.v === "middle" ? active.y + active.h / 2 : active.y + active.h - 9 * zoom, st.h ?? (isNumber ? "right" : "left"), 4 * zoom, st);
          ctx.restore();
        }
      }
    }
    const last = sel.ranges[sel.ranges.length - 1] ?? { r1: sel.active.row, c1: sel.active.col, r2: sel.active.row, c2: sel.active.col };
    const box = rect(last.r1, last.c1, last.r2 - last.r1 + 1, last.c2 - last.c1 + 1);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.w) - 1, Math.round(box.h) - 1);
    if (sel.ranges.length > 1 || last.r1 !== last.r2 || last.c1 !== last.c2) {
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(active.x) + 1.5, Math.round(active.y) + 1.5, Math.round(active.w) - 3, Math.round(active.h) - 3);
    }
    // the fill handle
    if (!overlay.editing && sel.ranges.length === 1) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(Math.round(box.x + box.w) - 3.5, Math.round(box.y + box.h) - 3.5, 7, 7);
      ctx.fillStyle = theme.bg;
      ctx.fillRect(Math.round(box.x + box.w) - 4.5, Math.round(box.y + box.h) - 4.5, 1, 9);
      ctx.fillRect(Math.round(box.x + box.w) - 4.5, Math.round(box.y + box.h) - 4.5, 9, 1);
    }
    if (overlay.fillTo) {
      const f = overlay.fillTo;
      const fb = rect(f.r1, f.c1, f.r2 - f.r1 + 1, f.c2 - f.c1 + 1);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.dim;
      ctx.strokeRect(Math.round(fb.x) + 0.5, Math.round(fb.y) + 0.5, Math.round(fb.w) - 1, Math.round(fb.h) - 1);
      ctx.setLineDash([]);
    }
    for (const ref of overlay.refs) {
      const rb = rect(ref.area.r1, ref.area.c1, ref.area.r2 - ref.area.r1 + 1, ref.area.c2 - ref.area.c1 + 1);
      ctx.strokeStyle = ref.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(rb.x) + 1, Math.round(rb.y) + 1, Math.round(rb.w) - 2, Math.round(rb.h) - 2);
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = ref.color;
      ctx.fillRect(rb.x, rb.y, rb.w, rb.h);
      ctx.globalAlpha = 1;
    }
    if (overlay.copied) {
      const cb = rect(overlay.copied.r1, overlay.copied.c1, overlay.copied.r2 - overlay.copied.r1 + 1, overlay.copied.c2 - overlay.copied.c1 + 1);
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -overlay.antsOffset;
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.accent;
      ctx.strokeRect(Math.round(cb.x) + 1, Math.round(cb.y) + 1, Math.round(cb.w) - 2, Math.round(cb.h) - 2);
      ctx.setLineDash([]);
    }
    const v = validationAt(sheet, sel.active.row, sel.active.col);
    if (v && v.kind === "list" && v.dropdown && !overlay.editing) {
      const ab = { x: active.x + active.w + 1, y: active.y, w: 16, h: active.h };
      ctx.fillStyle = theme.header;
      ctx.fillRect(ab.x, ab.y, ab.w, ab.h);
      ctx.strokeStyle = theme.grid;
      ctx.strokeRect(ab.x + 0.5, ab.y + 0.5, ab.w - 1, ab.h - 1);
      ctx.fillStyle = theme.text;
      ctx.beginPath();
      ctx.moveTo(ab.x + 4, ab.y + ab.h / 2 - 2);
      ctx.lineTo(ab.x + 12, ab.y + ab.h / 2 - 2);
      ctx.lineTo(ab.x + 8, ab.y + ab.h / 2 + 3);
      ctx.fill();
    }
    for (const bad of overlay.invalid ?? []) {
      const ib = rect(bad.row, bad.col);
      ctx.strokeStyle = "#ff3b30";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(ib.x + ib.w / 2, ib.y + ib.h / 2, ib.w / 2 + 2, ib.h / 2 + 1, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (overlay.found) {
      const fb = rect(overlay.found.row, overlay.found.col);
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(fb.x) + 1, Math.round(fb.y) + 1, Math.round(fb.w) - 2, Math.round(fb.h) - 2);
    }
    ctx.restore();
  }

  // headers
  const sel = overlay.selection;
  const rowSelected = (r: number) => sel.ranges.some((a) => r >= a.r1 && r <= a.r2);
  const colSelected = (c: number) => sel.ranges.some((a) => c >= a.c1 && c <= a.c2);
  const fullCol = (c: number) => sel.ranges.some((a) => a.r1 === 0 && a.r2 >= 1_048_575 && c >= a.c1 && c <= a.c2);
  const fullRow = (r: number) => sel.ranges.some((a) => a.c1 === 0 && a.c2 >= 16_383 && r >= a.r1 && r <= a.r2);
  ctx.font = `${(11.5 * zoom).toFixed(1)}px ${FONT}`;
  ctx.textAlign = "center";
  // column headers
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, width, hh);
  const drawColHeaders = (from: number, to: number, clipX: number, clipW: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, clipW, hh);
    ctx.clip();
    for (let c = from; c <= to; c++) {
      const w = cols.size(c);
      if (!w) continue;
      const box = rect(0, c);
      if (colSelected(c)) {
        ctx.fillStyle = fullCol(c) ? theme.accentSoft : theme.headerActive;
        ctx.fillRect(box.x, 0, box.w, hh);
      }
      ctx.fillStyle = colSelected(c) ? theme.headerActiveText : theme.headerText;
      ctx.fillText(colName(c), box.x + box.w / 2, hh / 2 + 1);
      ctx.fillStyle = theme.grid;
      ctx.fillRect(Math.round(box.x + box.w), 4, 1, hh - 8);
    }
    ctx.restore();
  };
  drawColHeaders(firstCol, lastCol, hw + layout.frozenW, width - hw - layout.frozenW);
  if (fc) drawColHeaders(0, fc - 1, hw, layout.frozenW);
  // row headers
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, hh, hw, height - hh);
  const drawRowHeaders = (from: number, to: number, clipY: number, clipH: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipY, hw, clipH);
    ctx.clip();
    for (let r = from; r <= to; r++) {
      const h = rows.size(r);
      if (!h) continue;
      const box = rect(r, 0);
      if (rowSelected(r)) {
        ctx.fillStyle = fullRow(r) ? theme.accentSoft : theme.headerActive;
        ctx.fillRect(0, box.y, hw, box.h);
      }
      ctx.fillStyle = rowSelected(r) ? theme.headerActiveText : theme.headerText;
      ctx.fillText(String(r + 1), hw / 2, box.y + box.h / 2 + 1);
      ctx.fillStyle = theme.grid;
      ctx.fillRect(4, Math.round(box.y + box.h), hw - 8, 1);
    }
    ctx.restore();
  };
  drawRowHeaders(firstRow, lastRow, hh + layout.frozenH, height - hh - layout.frozenH);
  if (fr) drawRowHeaders(0, fr - 1, hh, layout.frozenH);
  // header edges and the corner
  ctx.fillStyle = theme.grid;
  ctx.fillRect(0, hh - 1, width, 1);
  ctx.fillRect(hw - 1, 0, 1, height);
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, hw - 1, hh - 1);
  ctx.fillStyle = theme.headerText;
  ctx.beginPath();
  ctx.moveTo(hw - 6, hh - 12);
  ctx.lineTo(hw - 6, hh - 6);
  ctx.lineTo(hw - 12, hh - 6);
  ctx.fill();
  // freeze lines
  if (fr) {
    ctx.fillStyle = theme.frozen;
    ctx.fillRect(0, hh + layout.frozenH - 1, width, 2);
  }
  if (fc) {
    ctx.fillStyle = theme.frozen;
    ctx.fillRect(hw + layout.frozenW - 1, 0, 2, height);
  }
}

/** Width a column needs for its widest value (double-click its edge). */
export function fitWidth(canvas: HTMLCanvasElement, wb: Workbook, sheet: Sheet, col: number, zoom: number): number {
  const ctx = canvas.getContext("2d")!;
  let widest = 0;
  for (const [k, cell] of sheet.cells) {
    if (keyCol(k) !== col) continue;
    const r = keyRow(k);
    if (sheet.hiddenRows.has(r)) continue;
    const shown = wb.display(sheet, r, col);
    if (!shown.text) continue;
    ctx.font = fontOf(wb.style(cell.s), zoom);
    widest = Math.max(widest, ctx.measureText(shown.text.split("\n")[0]!).width);
  }
  for (const [anchor, area] of sheet.spills) {
    if (col < area.c1 || col > area.c2) continue;
    ctx.font = fontOf(wb.style(sheet.cells.get(anchor)?.s), zoom);
    for (let r = area.r1; r <= Math.min(area.r2, area.r1 + 2000); r++) widest = Math.max(widest, ctx.measureText(wb.display(sheet, r, col).text).width);
  }
  return widest ? Math.ceil(widest / zoom + 14) : 96;
}

export function fitHeight(canvas: HTMLCanvasElement, wb: Workbook, sheet: Sheet, row: number, zoom: number, colWidth: (c: number) => number): number {
  const ctx = canvas.getContext("2d")!;
  let tallest = 24;
  for (const [k, cell] of sheet.cells) {
    if (keyRow(k) !== row) continue;
    const st = wb.style(cell.s);
    const c = keyCol(k);
    const text = wb.display(sheet, row, c).text;
    if (!text) continue;
    ctx.font = fontOf(st, zoom);
    const lh = (st.size ?? 11) * 1.55;
    const lines = st.wrap ? wrapLines(ctx, text, colWidth(c) - 8).length : text.split("\n").length;
    tallest = Math.max(tallest, Math.ceil(lines * lh + 6), Math.ceil((st.size ?? 11) * 2.1));
  }
  return tallest;
}

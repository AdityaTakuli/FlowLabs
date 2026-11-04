// Zip files (what .xlsx is): reading and writing, with the browser's own deflate.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the end-of-central-directory record, searched from the end
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not an .xlsx file (it is not a zip archive).");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("The file is damaged (bad zip directory).");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + size);
    if (name.endsWith("/")) continue;
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await through(raw, new DecompressionStream("deflate-raw")));
    else throw new Error(`The file uses a zip compression FlowLabs can't read (method ${method}).`);
  }
  return files;
}

export async function zip(files: [string, Uint8Array | string][]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    const compressed = await through(data, new CompressionStream("deflate-raw"));
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, 8, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, compressed.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    parts.push(header, compressed);
    const entry = new Uint8Array(46 + nameBytes.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(8, 0x0800, true);
    e.setUint16(10, 8, true);
    e.setUint16(14, 0x21, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, compressed.length, true);
    e.setUint32(24, data.length, true);
    e.setUint16(28, nameBytes.length, true);
    e.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += header.length + compressed.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.length, true);
  d.setUint16(10, files.length, true);
  d.setUint32(12, centralSize, true);
  d.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) {
    all.set(part, p);
    p += part.length;
  }
  return all;
}

// ------------------------------------------------------------------------------------- XML

export interface XmlNode {
  name: string; // without namespace prefix
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)));
}
export function escapeXml(s: string): string {
  // characters XML 1.0 does not allow are dropped
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** A small XML reader, enough for the files inside .xlsx. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[4] ?? ""))) attrs[a[1]!.replace(/^.*:/, (p) => (p === "xmlns:" ? p : ""))] = unescapeXml(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
      top.children.push(node);
      if (m[5] !== "/") stack.push(node);
    } else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
  }
  return root.children[0] ?? root;
}

export const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
export const kid = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
/** All text inside a node (rich text runs joined). */
export function textOf(n: XmlNode | undefined): string {
  if (!n) return "";
  if (n.name === "t") return n.text;
  return n.children.filter((c) => c.name !== "rPh").map(textOf).join("");
}

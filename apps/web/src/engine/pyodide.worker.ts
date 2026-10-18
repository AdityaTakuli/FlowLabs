// The in-browser engine: Python (Pyodide) with pandas and scikit-learn, running the same FlowLabs
// engine code as the desktop app. Files live in IndexedDB, so projects survive a reload.

export const PYODIDE_VERSION = "314.0.7";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PACKAGES = ["numpy", "pandas", "scikit-learn", "scipy", "joblib", "pillow"];
const ROOT = "/flowlabs";
const WORKSPACE = `${ROOT}/workspace`;
const READ_ONLY = /^(engine\.|catalogue\.|datasets\.(list|profile|preview)|projects\.(list|get|check|preview|new_step|new_model)|runs\.(list|get)|export\.list|predict\.rows|sql\.(tables|kinds|connections))/;

const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null };
type Py = {
  loadPackage(names: string[] | string, options?: { messageCallback?: (m: string) => void }): Promise<void>;
  runPython(code: string): unknown;
  pyimport(name: string): any;
  unpackArchive(buffer: ArrayBuffer, format: string, options: { extractDir: string }): void;
  globals: { set(name: string, value: unknown): void };
  FS: any;
};

let py: Py | null = null;
let bridge: { call(method: string, params: string): string } | null = null;
let ready: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let duckdb: Promise<void> | null = null;

/** DuckDB loads the first time the SQL page runs a query, so the app starts without it. */
function loadDuckdb(): Promise<void> {
  duckdb ??= py!.loadPackage("duckdb").catch((error) => {
    duckdb = null;
    throw error;
  });
  return duckdb;
}

function report(stage: string, message: string, progress?: number) {
  scope.postMessage({ type: "event", event: { type: "boot", stage, message, progress } });
}

function syncfs(populate: boolean): Promise<void> {
  return new Promise((resolve) => py!.FS.syncfs(populate, () => resolve()));
}

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void syncfs(false), 300);
}

async function init(coreUrl: string, pyodideUrl?: string) {
  // the Android app ships Pyodide inside the APK; the website loads it from the CDN
  const base = pyodideUrl || CDN;
  report("runtime", "Starting Python…", 0.05);
  const { loadPyodide } = await import(/* @vite-ignore */ `${base}pyodide.mjs`);
  py = (await loadPyodide({ indexURL: base })) as Py;
  report("packages", "Loading pandas and scikit-learn (cached after the first visit)…", 0.25);
  let loaded = 0;
  await py.loadPackage(PACKAGES, {
    messageCallback: (message: string) => {
      if (message.startsWith("Loaded")) {
        loaded += 1;
        report("packages", message, Math.min(0.75, 0.25 + loaded * 0.03));
      }
    },
  });
  report("storage", "Opening your saved projects…", 0.8);
  py.FS.mkdirTree(ROOT);
  try {
    py.FS.mount(py.FS.filesystems.IDBFS, {}, ROOT);
    await syncfs(true);
  } catch {
    report("storage", "Browser storage is unavailable: projects last until you close this tab.", 0.82);
  }
  report("engine", "Loading the FlowLabs engine…", 0.9);
  const response = await fetch(coreUrl);
  if (!response.ok) throw new Error(`could not load the engine (${response.status})`);
  py.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: "/home/pyodide/flowlabs-src" });
  py.runPython(`import sys\nsys.path.insert(0, "/home/pyodide/flowlabs-src")`);
  const browser = py.pyimport("flowlabs.browser");
  bridge = browser;
  const emit = (text: string) => scope.postMessage({ type: "event", event: JSON.parse(text) });
  const reply = JSON.parse(browser.setup(WORKSPACE, emit));
  if (reply.error) throw new Error(reply.error.message);
  persist();
  report("ready", "Ready", 1);
  return reply.result;
}

function call(method: string, params: unknown): unknown {
  const reply = JSON.parse(bridge!.call(method, JSON.stringify(params ?? {})));
  if (!READ_ONLY.test(method)) persist();
  return reply;
}

async function upload(name: string, buffer: ArrayBuffer) {
  const folder = `${WORKSPACE}/tmp/${Math.random().toString(36).slice(2)}`;
  py!.FS.mkdirTree(folder);
  const path = `${folder}/${name.replace(/[\\/]/g, "_")}`;
  py!.FS.writeFile(path, new Uint8Array(buffer));
  if (/\.xlsx?$/i.test(name)) {
    report("packages", "Loading the Excel reader…");
    await py!.loadPackage("micropip");
    await py!.pyimport("micropip").install("openpyxl");
  }
  try {
    return call("datasets.import_path", { path, filename: name });
  } finally {
    try {
      py!.FS.unlink(path);
      py!.FS.rmdir(folder);
    } catch {
      /* already gone */
    }
  }
}

scope.onmessage = async (message: MessageEvent) => {
  const { id, type } = message.data;
  try {
    if (type === "init") {
      ready = init(message.data.coreUrl, message.data.pyodideUrl).then((info) => {
        scope.postMessage({ id, result: info });
      });
      await ready;
      return;
    }
    await ready;
    if (type === "call") {
      if (/^sql\.(run|save)$/.test(message.data.method)) await loadDuckdb();
      scope.postMessage({ id, ...(call(message.data.method, message.data.params) as object) });
    } else if (type === "upload") {
      scope.postMessage({ id, ...((await upload(message.data.name, message.data.buffer)) as object) });
    } else if (type === "read") {
      const data: Uint8Array = py!.FS.readFile(`${WORKSPACE}/${message.data.path}`);
      scope.postMessage({ id, result: data.buffer }, [data.buffer as ArrayBuffer]);
    }
  } catch (error) {
    scope.postMessage({ id, error: { message: String((error as Error)?.message ?? error), user: false } });
  }
};

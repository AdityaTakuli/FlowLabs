// The two Node calls the .xlsx tests use to read their fixture files (the app itself never runs in Node).
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: Uint8Array): void;
}
declare module "node:url" {
  export function fileURLToPath(url: URL): string;
}

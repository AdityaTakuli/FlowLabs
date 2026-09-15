import { Accessor } from './accessor.js';
export interface KeyOptions {
    get?: (path: string[]) => (obj: unknown) => unknown;
}
export default function key(fields: string | string[] | null | undefined, flat?: boolean, opt?: KeyOptions): Accessor<string>;
//# sourceMappingURL=key.d.ts.map
import { Accessor } from './accessor.js';
export interface FieldOptions {
    get?: (path: string[]) => (obj: unknown) => unknown;
}
export default function field(field: string, name?: string, opt?: FieldOptions): Accessor;
//# sourceMappingURL=field.d.ts.map
export interface Accessor<T = unknown> {
    (obj: unknown, ...args: unknown[]): T;
    fields?: readonly string[];
    fname?: string;
}
export default function accessor<T = unknown>(fn: (obj: unknown, ...args: unknown[]) => T, fields?: readonly string[], name?: string): Accessor<T>;
export declare function accessorName(fn: Accessor | null | undefined): string | null | undefined;
export declare function accessorFields(fn: Accessor | null | undefined): readonly string[] | null | undefined;
//# sourceMappingURL=accessor.d.ts.map
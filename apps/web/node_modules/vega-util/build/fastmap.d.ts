declare const NULL: {};
export interface FastMap<T = unknown> {
    size: number;
    empty: number;
    object: Record<string, T | typeof NULL>;
    has(key: string): boolean;
    get(key: string): T | undefined;
    set(key: string, value: T): FastMap<T>;
    delete(key: string): FastMap<T>;
    clear(): void;
    /** Use the test */
    test(): ((value: T) => boolean) | undefined;
    /** Set test function */
    test(fn: (value: T) => boolean): FastMap<T> | undefined;
    clean(): void;
}
export default function fastmap<T = unknown>(input?: Record<string, T>): FastMap<T>;
export {};
//# sourceMappingURL=fastmap.d.ts.map
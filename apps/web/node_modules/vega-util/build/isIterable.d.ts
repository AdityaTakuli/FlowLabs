/**
 * Test if the value exposes the iterator protocol via `Symbol.iterator`.
 */
export default function isIterable(value: {
    [Symbol.iterator]?: unknown;
} | null | undefined): boolean;
//# sourceMappingURL=isIterable.d.ts.map
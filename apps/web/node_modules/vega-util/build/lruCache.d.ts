export interface LRUCache<T> {
    clear: () => void;
    has: (key: string) => boolean;
    get: (key: string) => T | undefined;
    set: (key: string, value: T) => T;
}
/**
 * Adapted from https://github.com/dominictarr/hashlru/ (MIT License)
 */
export default function <T>(maxsize?: number): LRUCache<T>;
//# sourceMappingURL=lruCache.d.ts.map
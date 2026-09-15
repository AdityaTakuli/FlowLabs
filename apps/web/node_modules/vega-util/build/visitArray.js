/**
 * Implementation signature: Handles both cases at runtime.
 * Visitor accepts T | U because the actual type depends on whether filter is provided.
 */
export default function visitArray(array, filter, visitor) {
    if (array) {
        if (filter) {
            const n = array.length;
            for (let i = 0; i < n; ++i) {
                const t = filter(array[i]);
                if (t)
                    visitor(t, i, array);
            }
        }
        else {
            array.forEach(visitor);
        }
    }
}
//# sourceMappingURL=visitArray.js.map
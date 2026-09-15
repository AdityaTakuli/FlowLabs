/**
 * Implementation signature: Handles both cases at runtime.
 * Returns T | U since the actual type depends on whether an accessor function is provided.
 */
export default function extent(array, f) {
    let i = 0, n;
    let v;
    let min;
    let max;
    if (array && (n = array.length)) {
        if (f == null) {
            // find first valid value
            for (v = array[i]; i < n && (v == null || v !== v); v = array[++i])
                ;
            min = max = v;
            // visit all other values
            for (; i < n; ++i) {
                v = array[i];
                // skip null/undefined; NaN will fail all comparisons
                if (v != null) {
                    if (v < min)
                        min = v;
                    if (v > max)
                        max = v;
                }
            }
        }
        else {
            // find first valid value
            for (v = f(array[i]); i < n && (v == null || v !== v); v = f(array[++i]))
                ;
            min = max = v;
            // visit all other values
            for (; i < n; ++i) {
                v = f(array[i]);
                // skip null/undefined; NaN will fail all comparisons
                if (v != null) {
                    if (v < min)
                        min = v;
                    if (v > max)
                        max = v;
                }
            }
        }
    }
    return [min, max];
}
//# sourceMappingURL=extent.js.map
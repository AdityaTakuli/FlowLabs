/**
 * Implementation signature: Handles both cases at runtime.
 */
export default function extentIndex(array, f) {
    const n = array.length;
    let i = -1, u, v;
    let a;
    let b;
    let c;
    if (f == null) {
        // Find first non-null value to initialize min/max
        while (++i < n) {
            b = array[i];
            if (b != null && b >= b) {
                a = c = b;
                break;
            }
        }
        if (i === n)
            return [-1, -1];
        u = v = i;
        // At this point, a and c are guaranteed to be non-null/non-undefined
        // because the initialization loop above found a valid value before reaching here.
        // Non-null assertions (a!, c!) are used in the loop below.
        while (++i < n) {
            b = array[i];
            if (b != null) {
                if (a > b) {
                    a = b;
                    u = i;
                }
                if (c < b) {
                    c = b;
                    v = i;
                }
            }
        }
    }
    else {
        // Find first non-null value to initialize min/max
        while (++i < n) {
            b = f(array[i], i, array);
            if (b != null && b >= b) {
                a = c = b;
                break;
            }
        }
        if (i === n)
            return [-1, -1];
        u = v = i;
        // At this point, a and c are guaranteed to be non-null/non-undefined
        // because the initialization loop above found a valid value before reaching here.
        // Non-null assertions (a!, c!) are used in the loop below.
        while (++i < n) {
            b = f(array[i], i, array);
            if (b != null) {
                if (a > b) {
                    a = b;
                    u = i;
                }
                if (c < b) {
                    c = b;
                    v = i;
                }
            }
        }
    }
    return [u, v];
}
//# sourceMappingURL=extentIndex.js.map
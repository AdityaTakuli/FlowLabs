/**
 * Return an array with the indices of the minimum and maximum values, in the
 * form [minIndex, maxIndex]. Ignores null, undefined, and NaN values.
 * Returns [-1, -1] if no valid values are found.
 */
/**
 * Overload 1: Without accessor function, returns indices of min/max array values directly.
 * Example: extentIndex([3, 1, 5]) returns [1, 2] with type [number, number]
 */
export default function extentIndex<T>(array: ArrayLike<T>): [number, number];
/**
 * Overload 2: With accessor function that transforms T to U, returns indices based on transformed values.
 * Example: extentIndex([{a:3}, {a:1}, {a:5}], d => d.a) returns [1, 2] with type [number, number]
 * The accessor receives (value, index, array) and its return value is used for comparison.
 */
export default function extentIndex<T, U>(array: ArrayLike<T>, f: (value: T, index: number, array: ArrayLike<T>) => U): [number, number];
//# sourceMappingURL=extentIndex.d.ts.map
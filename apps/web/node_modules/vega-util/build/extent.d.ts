/**
 * Return an array with minimum and maximum values, in the
 * form [min, max]. Ignores null, undefined, and NaN values.
 */
/**
 * Overload 1: Without accessor function, returns extent of array values directly.
 * Example: extent([1, 5, 3]) returns [1, 5] with type [number | undefined, number | undefined]
 */
export default function extent<T>(array: ArrayLike<T>): [T | undefined, T | undefined];
/**
 * Overload 2: With accessor function that transforms T to U, returns extent of transformed values.
 * Example: extent([{a:1}, {a:5}], d => d.a) returns [1, 5] with type [number | undefined, number | undefined]
 * The returned extent has type U (the accessor's return type), not T (the array element type).
 */
export default function extent<T, U>(array: ArrayLike<T>, f: (value: T) => U): [U | undefined, U | undefined];
//# sourceMappingURL=extent.d.ts.map
import isFunction from './isFunction.js';
/**
 * Test if the value exposes the iterator protocol via `Symbol.iterator`.
 */
export default function isIterable(value) {
    return value != null && isFunction(value[Symbol.iterator]);
}
//# sourceMappingURL=isIterable.js.map
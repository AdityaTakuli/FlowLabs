/**
 * Confirm whether the value is a `RegExp` object.
 */
export default function isRegExp(value) {
    return Object.prototype.toString.call(value) === '[object RegExp]';
}
//# sourceMappingURL=isRegExp.js.map
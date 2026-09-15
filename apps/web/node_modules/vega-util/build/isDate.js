/**
 * Check if the value is an actual Date object.
 */
export default function isDate(value) {
    return Object.prototype.toString.call(value) === '[object Date]';
}
//# sourceMappingURL=isDate.js.map
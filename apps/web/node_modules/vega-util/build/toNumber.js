/**
 * Coerces a value to a number, returning `null` for empty inputs.
 */
export default function toNumber(_) {
    return _ == null || _ === '' ? null : +_;
}
//# sourceMappingURL=toNumber.js.map
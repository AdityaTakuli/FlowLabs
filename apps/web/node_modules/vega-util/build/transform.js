import error from './error.js';
import peek from './peek.js';
import toNumber from './toNumber.js';
function isNonEmpty(arr) {
    return arr.length > 0;
}
const exp = (sign) => x => sign * Math.exp(x);
const log = (sign) => x => Math.log(sign * x);
const symlog = (c) => x => Math.sign(x) * Math.log1p(Math.abs(x / c));
const symexp = (c) => x => Math.sign(x) * Math.expm1(Math.abs(x)) * c;
const pow = (exponent) => x => x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent);
// Internal wrappers to adapt utility functions to TransformFn signature
// Unlike toNumber, coerceNumber always returns a number (never null)
const coerceNumber = x => toNumber(x) ?? 0;
const identity = x => x;
function pan(domain, delta, lift, ground) {
    if (!isNonEmpty(domain))
        error('Domain array must not be empty');
    const d0 = lift(domain[0]), d1 = lift(peek(domain)), dd = (d1 - d0) * delta;
    return [
        ground(d0 - dd),
        ground(d1 - dd)
    ];
}
export function panLinear(domain, delta) {
    return pan(domain, delta, coerceNumber, identity);
}
export function panLog(domain, delta) {
    const sign = Math.sign(domain[0]);
    return pan(domain, delta, log(sign), exp(sign));
}
export function panPow(domain, delta, exponent) {
    return pan(domain, delta, pow(exponent), pow(1 / exponent));
}
export function panSymlog(domain, delta, constant) {
    return pan(domain, delta, symlog(constant), symexp(constant));
}
function zoom(domain, anchor, scale, lift, ground) {
    if (!isNonEmpty(domain))
        error('Domain array must not be empty');
    const d0 = lift(domain[0]), d1 = lift(peek(domain)), da = anchor != null ? lift(anchor) : (d0 + d1) / 2;
    return [
        ground(da + (d0 - da) * scale),
        ground(da + (d1 - da) * scale)
    ];
}
export function zoomLinear(domain, anchor, scale) {
    return zoom(domain, anchor, scale, coerceNumber, identity);
}
export function zoomLog(domain, anchor, scale) {
    const sign = Math.sign(domain[0]);
    return zoom(domain, anchor, scale, log(sign), exp(sign));
}
export function zoomPow(domain, anchor, scale, exponent) {
    return zoom(domain, anchor, scale, pow(exponent), pow(1 / exponent));
}
export function zoomSymlog(domain, anchor, scale, constant) {
    return zoom(domain, anchor, scale, symlog(constant), symexp(constant));
}
//# sourceMappingURL=transform.js.map
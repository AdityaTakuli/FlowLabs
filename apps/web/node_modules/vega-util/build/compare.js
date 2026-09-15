import { default as accessor, accessorFields } from './accessor.js';
import array from './array.js';
import field from './field.js';
import isFunction from './isFunction.js';
const DESCENDING = 'descending';
export default function compare(inputFields, inputOrders, inputOpt) {
    const opt = inputOpt || {};
    const orders = array(inputOrders) || [];
    const ord = [], get = [], fmap = {}, gen = opt.comparator || comparator;
    array(inputFields).forEach((f, i) => {
        if (f == null)
            return;
        ord.push(orders[i] === DESCENDING ? -1 : 1);
        const accessor = isFunction(f) ? f : field(f, undefined, opt);
        get.push(accessor);
        (accessorFields(accessor) || []).forEach(_ => fmap[_] = 1);
    });
    return get.length === 0
        ? null
        : accessor(gen(get, ord), Object.keys(fmap));
}
export const ascending = (_u, _v) => {
    let u = _u;
    let v = _v;
    return (u < v || u == null) && v != null ? -1
        : (u > v || v == null) && u != null ? 1
            : ((v = v instanceof Date ? +v : v), (u = u instanceof Date ? +u : u)) !== u && v === v ? -1
                : v !== v && u === u ? 1
                    : 0;
};
const comparator = (fields, orders) => fields.length === 1
    ? compare1(fields[0], orders[0])
    : compareN(fields, orders, fields.length);
const compare1 = (field, order) => function (a, b) {
    return ascending(field(a), field(b)) * order;
};
const compareN = (fields, orders, n) => {
    orders.push(0); // pad zero for convenient lookup
    return function (a, b) {
        let f, c = 0, i = -1;
        while (c === 0 && ++i < n) {
            f = fields[i];
            c = ascending(f(a), f(b));
        }
        return c * orders[i];
    };
};
//# sourceMappingURL=compare.js.map
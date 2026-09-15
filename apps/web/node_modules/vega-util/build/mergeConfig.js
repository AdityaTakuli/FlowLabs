import { isArray } from './isArray.js';
import isObject from './isObject.js';
const isLegalKey = (key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
export function mergeConfig(...configs) {
    return configs.reduce((out, source) => {
        for (const key in source) {
            if (key === 'signals') {
                // for signals, we merge the signals arrays
                // source signals take precedence over
                // existing signals with the same name
                out.signals = mergeNamed(out.signals, source.signals);
            }
            else {
                // otherwise, merge objects subject to recursion constraints
                // for legend block, recurse for the layout entry only
                // for style block, recurse for all properties
                // otherwise, no recursion: objects overwrite, no merging
                const r = key === 'legend' ? { layout: 1 }
                    : key === 'style' ? true
                        : null;
                writeConfig(out, key, source[key], r);
            }
        }
        return out;
    }, {});
}
/** Writes config value to output with optional recursion, rejecting illegal keys that could be used to modify the prototype chain */
export function writeConfig(output, key, value, recurse) {
    if (!isLegalKey(key))
        return;
    const out = output;
    let k, o;
    if (isObject(value) && !isArray(value)) {
        const valueObj = value;
        o = (isObject(out[key]) ? out[key] : (out[key] = {}));
        for (k in valueObj) {
            if (recurse && (recurse === true || recurse[k])) {
                writeConfig(o, k, valueObj[k]);
            }
            else if (isLegalKey(k)) {
                o[k] = valueObj[k];
            }
        }
    }
    else {
        out[key] = value;
    }
}
/** Merges named object arrays, deduplicating by name. (b takes precedence). */
function mergeNamed(a, b) {
    if (a == null)
        return b;
    if (b == null)
        return a;
    const map = {};
    const out = [];
    function add(item) {
        if (!map[item.name]) {
            map[item.name] = 1;
            out.push(item);
        }
    }
    b.forEach(add);
    a.forEach(add);
    return out;
}
//# sourceMappingURL=mergeConfig.js.map
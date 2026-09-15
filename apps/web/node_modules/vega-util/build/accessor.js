export default function accessor(fn, fields, name) {
    return Object.assign(fn, {
        fields: fields || [],
        fname: name
    });
}
export function accessorName(fn) {
    return fn == null ? null : fn.fname;
}
export function accessorFields(fn) {
    return fn == null ? null : fn.fields;
}
//# sourceMappingURL=accessor.js.map
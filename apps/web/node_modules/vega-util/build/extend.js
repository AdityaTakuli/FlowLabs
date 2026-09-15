export default function extend(_, ...args) {
    for (const arg of args) {
        for (const k in arg) {
            _[k] = arg[k];
        }
    }
    return _;
}
//# sourceMappingURL=extend.js.map
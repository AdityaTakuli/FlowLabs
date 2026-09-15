export default function toSet(_) {
    const s = {}, n = _.length;
    for (let i = 0; i < n; ++i)
        s[_[i] + ''] = true;
    return s;
}
//# sourceMappingURL=toSet.js.map
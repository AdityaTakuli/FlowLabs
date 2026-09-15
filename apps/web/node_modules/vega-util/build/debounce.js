export default function debounce(delay, handler) {
    let tid = null;
    return (e) => {
        if (tid)
            clearTimeout(tid);
        tid = setTimeout(() => (handler(e), tid = null), delay);
    };
}
//# sourceMappingURL=debounce.js.map
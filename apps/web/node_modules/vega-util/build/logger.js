function log(method, level, input) {
    const args = [level, ...input];
    console[method](...args); // eslint-disable-line no-console
}
export const None = 0;
export const Error = 1;
export const Warn = 2;
export const Info = 3;
export const Debug = 4;
export default function (_, method, handler = log) {
    let level = _ || None;
    return {
        level(_) {
            if (arguments.length) {
                level = +_;
                return this;
            }
            else {
                return level;
            }
        },
        error(...args) {
            if (level >= Error)
                handler(method || 'error', 'ERROR', args);
            return this;
        },
        warn(...args) {
            if (level >= Warn)
                handler(method || 'warn', 'WARN', args);
            return this;
        },
        info(...args) {
            if (level >= Info)
                handler(method || 'log', 'INFO', args);
            return this;
        },
        debug(...args) {
            if (level >= Debug)
                handler(method || 'log', 'DEBUG', args);
            return this;
        }
    };
}
//# sourceMappingURL=logger.js.map
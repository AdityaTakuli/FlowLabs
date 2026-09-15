type LogMethod = 'log' | 'warn' | 'error';
type LogHandler = (method: LogMethod, level: string, args: unknown[]) => void;
export declare const None = 0;
export declare const Error = 1;
export declare const Warn = 2;
export declare const Info = 3;
export declare const Debug = 4;
export interface LoggerInterface {
    level(_?: number): number | LoggerInterface;
    error(...args: unknown[]): this;
    warn(...args: unknown[]): this;
    info(...args: unknown[]): this;
    debug(...args: unknown[]): this;
}
export default function (_?: number, method?: LogMethod, handler?: LogHandler): LoggerInterface;
export {};
//# sourceMappingURL=logger.d.ts.map
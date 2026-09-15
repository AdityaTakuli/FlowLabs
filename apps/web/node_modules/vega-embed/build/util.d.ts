export declare function isURL(s: string): boolean;
/**
 * Return true if the string is a valid URL using a supported protocol (absolute paths using HTTP or HTTPS only).
 */
export declare function isValidEditorURL(url: string): boolean;
export type DeepPartial<T> = {
    [P in keyof T]?: P extends unknown ? unknown : DeepPartial<T[P]>;
};
export declare function mergeDeep<T>(dest: T, ...src: readonly DeepPartial<T>[]): T;
//# sourceMappingURL=util.d.ts.map
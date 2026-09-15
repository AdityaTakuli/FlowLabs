/** Merges Vega config objects. Signals merged by name (source takes precedence),
 * legend.layout recursively merged, style fully recursive, others shallow.
 *
 * The public signature is generic because declared interfaces such as the
 * vega-typings and vega-lite `Config` types have no implicit index signature
 * and would not be assignable to the internal structural types. */
export declare function mergeConfig<C extends object>(...configs: C[]): C;
/** Writes config value to output with optional recursion, rejecting illegal keys that could be used to modify the prototype chain */
export declare function writeConfig(output: object, key: string, value: unknown, recurse?: boolean | object | null): void;
//# sourceMappingURL=mergeConfig.d.ts.map
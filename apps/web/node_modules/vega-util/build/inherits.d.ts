type Constructor = new (...args: never[]) => unknown;
export default function <C extends Constructor, P extends Constructor>(child: C, parent: P, members?: object): object;
export {};
//# sourceMappingURL=inherits.d.ts.map
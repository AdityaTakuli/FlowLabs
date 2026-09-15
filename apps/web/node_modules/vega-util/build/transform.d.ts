type Domain = [number, number];
type Anchor = number | null | undefined;
export declare function panLinear(domain: number[], delta: number): Domain;
export declare function panLog(domain: number[], delta: number): Domain;
export declare function panPow(domain: number[], delta: number, exponent: number): Domain;
export declare function panSymlog(domain: number[], delta: number, constant: number): Domain;
export declare function zoomLinear(domain: number[], anchor: Anchor, scale: number): Domain;
export declare function zoomLog(domain: number[], anchor: Anchor, scale: number): Domain;
export declare function zoomPow(domain: number[], anchor: Anchor, scale: number, exponent: number): Domain;
export declare function zoomSymlog(domain: number[], anchor: Anchor, scale: number, constant: number): Domain;
export {};
//# sourceMappingURL=transform.d.ts.map
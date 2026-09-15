import { Accessor } from './accessor.js';
import { FieldOptions } from './field.js';
type Comparable = string | number | boolean | Date | null | undefined;
type SortOrder = 'descending' | 'ascending' | string;
/** A single field specification - either a field path string or an accessor function. */
type FieldSpec = string | Accessor | ((obj: unknown) => unknown);
type FieldsInput = FieldSpec | readonly FieldSpec[] | null | undefined;
type OrdersInput = SortOrder | readonly SortOrder[] | null | undefined;
type CompareFn = (a: unknown, b: unknown) => number;
/** A function that generates a comparator from field accessors and order multipliers. */
type ComparatorGenerator = (fields: Accessor[], orders: number[]) => CompareFn;
export interface CompareOptions extends FieldOptions {
    comparator?: ComparatorGenerator;
}
export default function compare(inputFields: FieldsInput, inputOrders?: OrdersInput, inputOpt?: CompareOptions): Accessor<number> | null;
export declare const ascending: (_u: Comparable, _v: Comparable) => -1 | 0 | 1;
export {};
//# sourceMappingURL=compare.d.ts.map
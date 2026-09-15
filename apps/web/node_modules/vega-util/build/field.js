import accessor from './accessor.js';
import getter from './getter.js';
import splitAccessPath from './splitAccessPath.js';
export default function field(field, name, opt) {
    const path = splitAccessPath(field);
    const fieldName = path.length === 1 ? path[0] : field;
    return accessor((opt && opt.get || getter)(path), [fieldName], name || fieldName);
}
//# sourceMappingURL=field.js.map
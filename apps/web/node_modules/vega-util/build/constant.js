import isFunction from './isFunction.js';
export default function (_) {
    return isFunction(_) ? _ : () => _;
}
//# sourceMappingURL=constant.js.map
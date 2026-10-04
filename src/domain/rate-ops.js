// 分类标准与税率阶梯共用的属性判定运算符。
export const OPS = Object.freeze({
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  gte: (a, b) => typeof a === "number" && a >= b,
  lte: (a, b) => typeof a === "number" && a <= b,
  gt: (a, b) => typeof a === "number" && a > b,
  lt: (a, b) => typeof a === "number" && a < b,
});

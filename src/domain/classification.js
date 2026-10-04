// 产品技术分类：仅依据可核验技术属性（profile.attributes）与有效检验证据。
// 市场名称（market_name）不参与任何判定，改名历史只用于审计留痕。
// 分类标准随法规版本保存（rule.categories[].criteria），保证可重放。

const OPS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  gte: (a, b) => typeof a === "number" && a >= b,
  lte: (a, b) => typeof a === "number" && a <= b,
  gt: (a, b) => typeof a === "number" && a > b,
  lt: (a, b) => typeof a === "number" && a < b,
};

function evalCondition(attrs, cond) {
  const value = attrs[cond.attribute];
  if (value === undefined || value === null) return "unknown";
  const op = OPS[cond.op];
  if (!op) throw new Error(`未知判定运算符：${cond.op}`);
  return op(value, cond.value) ? "matched" : "failed";
}

// 证据在某时刻是否有效：已签发且未过有效期（均为带时区时刻）。
export function evidenceValidAt(evidence, instant) {
  const t = instant instanceof Date ? instant : new Date(instant);
  if (new Date(evidence.issued_at).getTime() > t.getTime()) return false;
  if (evidence.valid_until && new Date(evidence.valid_until).getTime() <= t.getTime()) return false;
  return true;
}

// 评估一个税目分类标准。
// 返回 status: matched（全部条件满足）| failed（存在明确不满足）| unknown（有属性缺失但无明确失败）
function evaluateCategory(category, attrs, evidenceList, instant) {
  const requires = category.criteria?.requires || [];
  const conditionResults = requires.map((cond) => ({
    cond,
    result: evalCondition(attrs, cond),
  }));
  const failed = conditionResults.filter((r) => r.result === "failed");
  const unknowns = conditionResults.filter((r) => r.result === "unknown");
  const status = failed.length ? "failed" : unknowns.length ? "unknown" : "matched";

  const validEvidence = evidenceList.filter((e) => evidenceValidAt(e, instant));
  const coveredAttrs = new Set(validEvidence.flatMap((e) => e.attributes_verified));
  const evidenceTypes = new Set(validEvidence.map((e) => e.evidence_type));

  const requiredAttrs = (category.criteria?.required_attributes || []).filter(
    (a) => !coveredAttrs.has(a)
  );
  const requiredEvidenceTypes = (category.criteria?.required_evidence_types || []).filter(
    (t) => !evidenceTypes.has(t)
  );

  return {
    category: category.category,
    title: category.title,
    status,
    conditionResults,
    missing_required_attributes: requiredAttrs,
    missing_evidence_types: requiredEvidenceTypes,
    complete:
      status === "matched" &&
      requiredAttrs.length === 0 &&
      requiredEvidenceTypes.length === 0,
  };
}

// 主入口：给出候选分类、缺失证据与边界标记。
// 返回 { candidates:[{category,title,confidence,reasons}], missing_evidence:[...], boundary, evaluations }
export function classify({ profile, evidence, rule, asOf }) {
  const instant = asOf instanceof Date ? asOf : new Date(asOf);
  const attrs = profile.attributes || {};
  const evaluations = (rule.categories || []).map((c) =>
    evaluateCategory(c, attrs, evidence, instant)
  );

  const matched = evaluations.filter((e) => e.status === "matched");
  const unknown = evaluations.filter((e) => e.status === "unknown");

  const candidates = matched.map((e) => ({
    category: e.category,
    title: e.title,
    confidence: e.complete ? "verified" : "incomplete_evidence",
    reasons: e.conditionResults.map(
      (r) => `${r.cond.attribute} ${r.cond.op} ${JSON.stringify(r.cond.value)}`
    ),
    missing_required_attributes: e.missing_required_attributes,
    missing_evidence_types: e.missing_evidence_types,
  }));

  const missing_evidence = matched
    .filter((e) => !e.complete)
    .flatMap((e) => [
      ...e.missing_required_attributes.map(
        (a) => `税目 ${e.category}：技术属性「${a}」缺少有效检验证据核验`
      ),
      ...e.missing_evidence_types.map(
        (t) => `税目 ${e.category}：缺少证据类型「${evidenceTypeLabel(t)}」`
      ),
    ])
    .concat(
      unknown.map(
        (e) =>
          `税目 ${e.category}：属性 ${e.conditionResults
            .filter((r) => r.result === "unknown")
            .map((r) => r.cond.attribute)
            .join("、")} 未提供，无法排除该分类`
      )
    );

  // 边界产品：多候选、零候选、或候选证据不完整。
  const noCandidates = candidates.length === 0;
  if (noCandidates) {
    missing_evidence.push(
      unknown.length
        ? `存在 ${unknown.length} 个税目因属性缺失无法排除，须补充材料或由授权人员裁定`
        : "现有可核验属性不满足任何已登记税目；如主张适用某税目，须由授权税务人员签署裁定"
    );
  }
  const boundary =
    candidates.length > 1 ||
    candidates.some((c) => c.confidence !== "verified") ||
    noCandidates;

  return { candidates, missing_evidence, boundary, evaluations, at: instant.toISOString() };
}

export function evidenceTypeLabel(t) {
  return (
    {
      test_report: "第三方检验报告",
      composition_bom: "组成物料清单",
      process_spec: "工艺规格书",
      datasheet: "产品技术规格书",
      pilot_qualification: "阶段性免税试制资质文件",
      other: "其他证明材料",
    }[t] || t
  );
}

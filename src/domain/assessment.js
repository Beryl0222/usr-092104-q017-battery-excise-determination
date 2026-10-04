// 计税：税率由“法定时点 + 已确认技术分类”共同决定，输出可解释的计税结论。
// 计税价格采用不含增值税价格（发票行单价×数量）；模组/系统耗用已税电芯时，
// 可按生产领用数量计算外购已纳消费税扣除（连续生产应税消费品），扣除以凭证为限。

import { scopeOfCategory } from "./catalog.js";
import { resolveForScope } from "./rules.js";

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// creditInputs: [{lot_id, quantity, tax_paid, voucher_ref}]，来自 upstream_tax_voucher 证据与 COMPONENT_CONSUMED
export function calculateTax({
  classification, // evaluateProfile 的结果
  rulesState,
  taxPoint, // determineTaxPoint 的结果
  priceInput, // {quantity, unit_price_ex_vat, currency}
  creditInputs = [],
}) {
  const blockers = [];
  if (!taxPoint?.tax_point_ms) blockers.push("应税时点无法确定（缺少合同/出库/开票/收款事实）");
  if (classification.requires_signature) {
    blockers.push(
      `分类未经确认：候选 ${classification.candidates.map((c) => c.category).join("/")}，` +
        `缺失证据 ${[...new Set(classification.candidates.flatMap((c) => c.missing_evidence))].join("、") || "无"}，` +
        (classification.candidates.some((c) => c.boundary) ? "边界产品须授权人员签署" : "证据齐备后方可确认"),
    );
  }
  if (classification.contradictions.length > 0) {
    blockers.push("技术属性与检验报告实测矛盾，禁止计税（涉嫌改名/虚报）");
  }
  if (blockers.length > 0) {
    return { ok: false, blockers, taxable_point_ms: taxPoint?.tax_point_ms ?? null };
  }

  const scope = scopeOfCategory(classification.decided_category);
  const atMs = taxPoint.tax_point_ms;
  // 只有技术证据 +（边界时）签署确认属于固态试制对象时，才允许在重叠区间选择免税版本。
  const preferExemption = classification.decided_category === "solid_state_cell";
  let rule;
  try {
    rule = resolveForScope(rulesState, scope, atMs, { preferExemption });
  } catch (err) {
    return { ok: false, blockers: [err.message] };
  }
  if (!rule) {
    return { ok: false, blockers: [`法定时点 ${new Date(atMs).toISOString()} 在征税范围 ${scope} 上没有可适用的法规版本`] };
  }
  if (rule.is_exempt && rule.rate !== 0) {
    return { ok: false, blockers: ["免税版本税率必须为 0，数据异常"] };
  }

  const grossPrice = round2(priceInput.quantity * priceInput.unit_price_ex_vat);
  const grossTax = round2(grossPrice * rule.rate);

  const credit = round2(creditInputs.reduce((sum, x) => sum + (x.tax_paid ?? 0), 0));
  const creditCapped = Math.min(credit, grossTax); // 已纳税款扣除不得超过应纳税额

  const taxAmount = round2(grossTax - creditCapped);

  return {
    ok: true,
    tax_point_ms: atMs,
    decided_category: classification.decided_category,
    tax_scope: scope,
    rule: {
      rule_id: rule.rule_id,
      version_no: rule.version_no,
      citation: rule.citation,
      rate: rule.rate,
      is_exempt: rule.is_exempt,
      effective_from_ms: rule.effective_from_ms,
      effective_to_ms: Number.isFinite(rule.effective_to_ms) ? rule.effective_to_ms : null,
      effective_from_raw: rule.effective_from_raw,
      effective_to_raw: rule.effective_to_raw,
    },
    price: {
      quantity: priceInput.quantity,
      unit_price_ex_vat: priceInput.unit_price_ex_vat,
      currency: priceInput.currency ?? "CNY",
      taxable_price: grossPrice,
      price_basis: "不含增值税的实际成交价格（发票行金额合计）",
    },
    credit: { total: credit, applied: creditCapped, clipped: credit > grossTax, inputs: creditInputs },
    tax_amount: taxAmount,
    formula: rule.is_exempt
      ? `阶段性免税（${rule.citation}）：应纳税额 = 0`
      : `应纳税额 = 计税价格 ${grossPrice} × 税率 ${(rule.rate * 100).toFixed(2)}% − 外购已纳消费税扣除 ${creditCapped} = ${taxAmount}`,
    explanation: {
      rule_application: {
        chosen_rule: `${rule.rule_id}@${rule.version_no}`,
        citation: rule.citation,
        interval: `[${rule.effective_from_raw}, ${rule.effective_to_raw ?? "∞"})`,
        rate: rule.rate,
        is_exempt: rule.is_exempt,
      },
      classification_evidence: {
        category: classification.decided_category,
        basis: classification.decision_basis,
        contradictions: classification.contradictions,
      },
      tax_point: { at: new Date(atMs).toISOString(), basis: taxPoint.basis, facts: taxPoint.facts },
      price_basis: "不含增值税实际成交价；退货/折让另以冲正分录调整，不修改本结论",
      credit_basis: creditInputs.length
        ? `领用已税电芯/模组，凭上游已纳税凭证扣除，凭证合计 ${credit}，实际扣除 ${creditCapped}`
        : "无外购已纳税款扣除",
      formula_text: rule.is_exempt
        ? `阶段性免税（${rule.citation}）：应纳税额 = 0`
        : `计税价格 ${grossPrice} × ${(rule.rate * 100).toFixed(2)}% − 扣除 ${creditCapped} = ${taxAmount}`,
    },
  };
}

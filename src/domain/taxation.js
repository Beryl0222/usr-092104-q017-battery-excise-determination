// 计税引擎：法规版本解析、税率阶梯与阶段性免税、应税时点、计税价格、税额。
// 全部为纯函数；任何一次税额都同时产出可重放的 explanation（法规、分类证据、价格、时点推导）。

import { localDayOf, dayInRange, ruleEffectiveAt } from "./time.js";
import { OPS } from "./rate-ops.js";
import { evidenceValidAt } from "./classification.js";

// 在某时刻解析生效中的法规版本（同一 code 仅允许一个版本生效，注册时已保证不重叠）。
export function resolveRule(ruleRegistry, ruleCode, instant) {
  const t = instant instanceof Date ? instant : new Date(instant);
  const all = ruleRegistry instanceof Map ? ruleRegistry.get(ruleCode) : ruleRegistry[ruleCode];
  const versions = (all || []).filter((r) => ruleEffectiveAt(r, t));
  if (versions.length === 0) return { ok: false, error: `时刻 ${t.toISOString()} 没有生效中的法规版本：${ruleCode}` };
  if (versions.length > 1)
    return { ok: false, error: `法规 ${ruleCode} 在 ${t.toISOString()} 存在重叠生效版本` };
  return { ok: true, rule: versions[0] };
}

function findCategory(rule, category) {
  const found = (rule.categories || []).find((c) => c.category === category);
  if (!found) return { ok: false, error: `法规版本 ${rule.rule_version} 不含税目：${category}` };
  return { ok: true, category: found };
}

// 阶段性免税：按法规时区的当地日落在免税窗口内，且窗口要求的证据类型齐备，才免税。
function exemptionAt(categoryDef, instant, rule, evidenceList = []) {
  const day = localDayOf(instant, rule.time_zone);
  for (const w of categoryDef.exemption_windows || []) {
    if (!dayInRange(day, w.start, w.end)) continue;
    const requiredEvidence = w.requires_evidence_types || [];
    const have = new Set(
      evidenceList
        .filter((e) => evidenceValidAt(e, instant))
        .map((e) => e.evidence_type)
    );
    const missing = requiredEvidence.filter((t) => !have.has(t));
    if (missing.length) {
      return {
        exempt: false,
        window: { start: w.start, end: w.end },
        local_day: day,
        phase: w.phase || "exemption",
        exemption_denied_reason: `落在免税窗口但缺少资质证据：${missing.join("、")}`,
      };
    }
    return {
      exempt: true,
      phase: w.phase || "exemption",
      window: { start: w.start, end: w.end },
      local_day: day,
    };
  }
  return { exempt: false };
}

// 税率阶梯：tiers 按顺序匹配，无条件的 tier 为兜底档；所需属性缺失即报错而非静默兜底。
function resolveTier(categoryDef, attrs) {
  const tiers = categoryDef.thresholds || [];
  for (const tier of tiers) {
    const conds = tier.conditions || legacyConditions(tier);
    if (conds.length === 0) return { ok: true, tier, rate: tier.rate };
    const results = conds.map((c) => {
      const value = attrs[c.attribute];
      if (value === undefined || value === null) return { missing: c.attribute };
      const op = OPS[c.op] || OPS.lte;
      return { matched: op(value, c.value), c, value };
    });
    const missing = results.filter((r) => r.missing).map((r) => r.missing);
    if (missing.length) return { ok: false, error: `税率阶梯缺少技术属性：${missing.join("、")}` };
    if (results.every((r) => r.matched)) {
      return {
        ok: true,
        tier: { ...tier, matched_conditions: results.map((r) => ({ ...r.c, actual: r.value })) },
        rate: tier.rate,
      };
    }
  }
  return { ok: true, tier: { default: true }, rate: categoryDef.rate };
}

// 兼容样例中的旧式写法 { up_to_energy_density_wh_per_kg: 300 }
function legacyConditions(tier) {
  const conds = [];
  for (const [key, value] of Object.entries(tier)) {
    if (key === "rate") continue;
    if (key.startsWith("up_to_")) conds.push({ attribute: key.slice(6), op: "lte", value });
    if (key.startsWith("from_")) conds.push({ attribute: key.slice(5), op: "gte", value });
  }
  return conds;
}

// 解析税率（先免税窗口，再税率阶梯，再税目默认税率）。
export function resolveRate(rule, category, attrs, instant, evidence = []) {
  const catResult = findCategory(rule, category);
  if (!catResult.ok) return catResult;
  const cat = catResult.category;
  const exemption = exemptionAt(cat, instant, rule, evidence);
  if (exemption.exempt) {
    return { ok: true, rate: 0, exempt: true, exemption, tier: null };
  }
  const tierResult = resolveTier(cat, attrs || {});
  if (!tierResult.ok) return tierResult;
  return { ok: true, rate: tierResult.rate, exempt: false, exemption: null, tier: tierResult.tier };
}

// 应税时点（货物类消费税缺省政策 cn_goods_default）。
// 输入：contract（可能为空）、invoice（可能为空）、dispatch（可能为空）。
// 赊销/分期：合同约定收款日，无约定则发货日；预收：发货日；直接收款：收款凭据日（实际收款，缺省取发货）。
// 先开具发票的，以开票日为准（取较早者）。
export function resolveTaxablePoint({ contract, invoice, dispatch, usageChange }) {
  const steps = [];
  if (usageChange) {
    steps.push(`用途变化：以移送/改变用途当天 ${usageChange.changed_at} 为纳税义务发生时间`);
    return {
      ok: true,
      taxable_event: "usage_change",
      at: usageChange.changed_at,
      steps,
      candidates: { usage_change: usageChange.changed_at },
    };
  }

  const candidates = {};
  if (contract?.contracted_at) candidates.contract = contract.contracted_at;
  if (invoice?.issued_at) candidates.invoice = invoice.issued_at;
  if (dispatch?.dispatched_at) candidates.dispatch = dispatch.dispatched_at;
  if (contract?.payment_due_at) candidates.payment_due = contract.payment_due_at;
  if (contract?.payment_received_at) candidates.payment_received = contract.payment_received_at;

  let base;
  let baseLabel;
  const terms = contract?.settlement_terms;
  if (!contract && !dispatch && !invoice) {
    return { ok: false, error: "缺少合同、发货与开票信息，无法判定应税时点" };
  }
  if (terms === "on_credit" || terms === "installment") {
    if (contract.payment_due_at) {
      base = contract.payment_due_at;
      baseLabel = "payment_due";
      steps.push(`${terms === "installment" ? "分期收款" : "赊销"}：采用书面合同约定的收款日期 ${base}`);
    } else if (dispatch?.dispatched_at) {
      base = dispatch.dispatched_at;
      baseLabel = "dispatch";
      steps.push("赊销/分期但合同未约定收款日期：以货物发出当天为纳税义务发生时间");
    } else {
      return { ok: false, determinable: false, error: "赊销/分期合同未约定收款日且货物尚未发出，纳税义务尚未发生", candidates };
    }
  } else if (terms === "prepayment") {
    if (!dispatch?.dispatched_at) {
      return { ok: false, determinable: false, error: "预收货款方式：货物尚未发出，纳税义务尚未发生", candidates };
    }
    base = dispatch.dispatched_at;
    baseLabel = "dispatch";
    steps.push("预收货款方式：以货物发出当天为纳税义务发生时间");
  } else {
    // 直接收款（含结算条款缺省）：收到销售款或取得索取销售款凭据的当天
    if (contract?.payment_received_at) {
      base = contract.payment_received_at;
      baseLabel = "payment_received";
      steps.push("直接收款方式：以收到销售款当天为纳税义务发生时间");
    } else if (dispatch?.dispatched_at) {
      base = dispatch.dispatched_at;
      baseLabel = "dispatch";
      steps.push("直接收款方式：以取得索取销售款凭据（货物发出）当天为纳税义务发生时间");
    } else if (contract?.contracted_at) {
      base = contract.contracted_at;
      baseLabel = "contract";
      steps.push("直接收款方式：合同已签订，暂以合同日为凭据日（发货/收款后重算）");
    } else {
      return { ok: false, determinable: false, error: "直接收款方式：尚无收款、发货或合同凭据，纳税义务尚未发生", candidates };
    }
  }

  let selected = base;
  let label = baseLabel;
  if (invoice?.issued_at && Date.parse(invoice.issued_at) < Date.parse(base)) {
    selected = invoice.issued_at;
    label = "invoice";
    steps.push(`先开具发票（${invoice.issued_at} 早于 ${base}）：以开票日期为纳税义务发生时间`);
  } else if (invoice?.issued_at) {
    steps.push(`开票日 ${invoice.issued_at} 不早于基础时点，纳税义务发生时间不变`);
  }

  return { ok: true, taxable_event: label, at: selected, steps, candidates };
}

// 计税价格：实际成交价（不含增值税口径由上游系统保证）；发票价格优先，无票取合同价并标注待重算。
export function resolveBasisPrice({ contract, invoice }) {
  const sources = [];
  if (contract) sources.push({ source: "contract", price: contract.contracted_price, at: contract.contracted_at });
  if (invoice) sources.push({ source: "invoice", price: invoice.invoice_price, at: invoice.issued_at });
  if (invoice) {
    const diff = contract && Math.abs(invoice.invoice_price - contract.contracted_price) > 1e-9;
    return {
      ok: true,
      price: invoice.invoice_price,
      source: "invoice",
      sources,
      note: diff ? "发票价格与合同价格不一致，按发票价格计税并留痕" : "按发票价格计税",
    };
  }
  if (contract) {
    return { ok: true, price: contract.contracted_price, source: "contract_pending_invoice", sources, note: "尚未开票，暂按合同价格计税，开票后应复核" };
  }
  return { ok: false, error: "缺少合同与发票，无法确定计税价格" };
}

function roundTax(amount, rounding) {
  const decimals = rounding?.decimals ?? 2;
  const f = 10 ** decimals;
  const mode = rounding?.mode || "half_up";
  if (mode === "half_up") return Math.round((amount + Number.EPSILON) * f) / f;
  if (mode === "half_even") {
    const scaled = amount * f;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    if (diff > 0.5) return Math.ceil(scaled) / f;
    if (diff < 0.5) return floor / f;
    return (floor % 2 === 0 ? floor : floor + 1) / f;
  }
  return amount;
}

// 完整计税：输入上下文，返回税额分录要素 + 解释。
export function calculateTax(ctx) {
  const { ruleRegistry, ruleCode, category, profile, contract, invoice, dispatch, usageChange, quantity, unit, currency } = ctx;
  const point = resolveTaxablePoint({ contract, invoice, dispatch, usageChange });
  if (!point.ok) return point;

  const ruleResult = resolveRule(ruleRegistry, ruleCode, point.at);
  if (!ruleResult.ok) return ruleResult;
  const rule = ruleResult.rule;

  const rateResult = resolveRate(rule, category, profile?.attributes, point.at, ctx.evidence || []);
  if (!rateResult.ok) return rateResult;

  const priceResult = resolveBasisPrice({ contract, invoice });
  if (!priceResult.ok) return priceResult;

  const qty = quantity ?? dispatch?.quantity ?? contract?.quantity;
  if (typeof qty !== "number" || qty <= 0) return { ok: false, error: "缺少有效数量" };

  const rawAmount = priceResult.price * qty * rateResult.rate;
  const tax_amount = roundTax(rawAmount, rule.rounding);

  const explanation = {
    rule: {
      rule_code: rule.rule_code,
      rule_version: rule.rule_version,
      title: rule.title,
      legal_basis: rule.legal_basis,
      effective_start: rule.effective_start,
      effective_end: rule.effective_end || null,
      time_zone: rule.time_zone,
      local_taxable_day: localDayOf(point.at, rule.time_zone),
    },
    classification: ctx.classification
      ? {
          category,
          signed_at: ctx.classification.signed_at,
          signer: ctx.classification.signer,
          signer_role: ctx.classification.signer_role,
          boundary: ctx.classification.boundary,
          evidence_refs: ctx.classification.evidence_refs,
          valid_from: ctx.classification.valid_from,
          valid_until: ctx.classification.valid_until || null,
        }
      : null,
    taxable_point: {
      selected_event: point.taxable_event,
      selected_at: point.at,
      candidates: point.candidates,
      steps: point.steps,
    },
    price: {
      selected_source: priceResult.source,
      tax_basis_price: priceResult.price,
      note: priceResult.note,
      sources: priceResult.sources,
    },
    rate: {
      rate: rateResult.rate,
      exempt: rateResult.exempt,
      exemption: rateResult.exemption,
      tier: rateResult.tier,
      category_default_rate: findCategory(rule, category).category?.rate ?? null,
    },
    computation: {
      formula: rateResult.exempt ? "免税：tax_amount = 0" : "tax_amount = tax_basis_price × quantity × rate",
      tax_basis_price: priceResult.price,
      quantity: qty,
      unit: unit || dispatch?.unit || contract?.unit,
      rate: rateResult.rate,
      raw_amount: rawAmount,
      rounding: rule.rounding || { decimals: 2, mode: "half_up" },
      tax_amount,
      currency: currency || invoice?.currency || contract?.currency,
    },
  };

  return {
    ok: true,
    taxable_event: point.taxable_event,
    taxable_event_at: point.at,
    rule,
    rate: rateResult.rate,
    exempt: rateResult.exempt,
    tax_basis_price: priceResult.price,
    quantity: qty,
    currency: currency || invoice?.currency || contract?.currency,
    tax_amount,
    explanation,
  };
}

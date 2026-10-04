import assert from "node:assert/strict";
import test from "node:test";

import { resolveRule, resolveRate, resolveTaxablePoint, calculateTax } from "../src/domain/taxation.js";

const CN = "Asia/Shanghai";

function rule(version, { start, end, rate, thresholds, windows } = {}) {
  return {
    rule_code: "LI",
    rule_version: version,
    title: "t",
    legal_basis: "b",
    effective_start: start,
    effective_end: end || null,
    time_zone: CN,
    rounding: { decimals: 2, mode: "half_up" },
    categories: [
      {
        category: "c",
        rate,
        ...(thresholds ? { thresholds } : {}),
        ...(windows ? { exemption_windows: windows } : {}),
      },
    ],
  };
}

const registry = new Map([
  [
    "LI",
    [
      rule(1, { start: "2026-01-01", end: "2026-08-31", rate: 0.02 }),
      rule(2, { start: "2026-09-01", rate: 0.04 }),
    ],
  ],
]);

test("按法定时刻解析法规版本", () => {
  assert.equal(resolveRule(registry, "LI", "2026-08-31T23:59:59+08:00").rule.rule_version, 1);
  assert.equal(resolveRule(registry, "LI", "2026-09-01T00:00:00+08:00").rule.rule_version, 2);
});

test("2%→4% 阶梯版本切换：同一业务不同时点税额不同", () => {
  const attrs = {};
  const r1 = resolveRate(registry.get("LI")[0], "c", attrs, "2026-08-31T12:00:00+08:00");
  const r2 = resolveRate(registry.get("LI")[1], "c", attrs, "2026-09-01T12:00:00+08:00");
  assert.equal(r1.rate, 0.02);
  assert.equal(r2.rate, 0.04);
});

test("税率阶梯按技术属性分档", () => {
  const v2 = rule(2, {
    start: "2026-09-01",
    rate: 0.04,
    thresholds: [
      { conditions: [{ attribute: "d", op: "lte", value: 300 }], rate: 0.02 },
      { conditions: [], rate: 0.04 },
    ],
  });
  assert.equal(resolveRate(v2, "c", { d: 300 }, "2026-09-01T12:00:00+08:00").rate, 0.02);
  assert.equal(resolveRate(v2, "c", { d: 301 }, "2026-09-01T12:00:00+08:00").rate, 0.04);
});

test("阶梯判定所需属性缺失时报错而非兜底高档或低档", () => {
  const v2 = rule(2, {
    start: "2026-09-01",
    rate: 0.04,
    thresholds: [
      { conditions: [{ attribute: "d", op: "lte", value: 300 }], rate: 0.02 },
      { conditions: [], rate: 0.04 },
    ],
  });
  const r = resolveRate(v2, "c", {}, "2026-09-01T12:00:00+08:00");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("d"));
});

test("阶段性免税：窗口内且有资质证据→0；窗口外→正常税率；窗口内缺资质→不免税", () => {
  const v2 = rule(2, {
    start: "2026-09-01",
    rate: 0.04,
    windows: [
      { start: "2026-09-01", end: "2027-12-31", phase: "pilot", requires_evidence_types: ["pilot_qualification"] },
    ],
  });
  const qualified = [{ evidence_type: "pilot_qualification", issued_at: "2026-08-01T00:00:00+08:00", attributes_verified: [] }];
  assert.equal(resolveRate(v2, "c", {}, "2026-09-02T00:00:00+08:00", qualified).exempt, true);
  assert.equal(resolveRate(v2, "c", {}, "2028-01-02T00:00:00+08:00", qualified).exempt, false);
  const denied = resolveRate(v2, "c", {}, "2026-09-02T00:00:00+08:00", []);
  assert.equal(denied.exempt, false);
  assert.ok(denied.exemption.exemption_denied_reason.includes("pilot_qualification"));
});

test("应税时点：预收以发货日为准，签约日不决定税率版本", () => {
  const p = resolveTaxablePoint({
    contract: { contracted_at: "2026-08-30T10:00:00+08:00", settlement_terms: "prepayment" },
    dispatch: { dispatched_at: "2026-09-02T09:00:00+08:00" },
  });
  assert.equal(p.at, "2026-09-02T09:00:00+08:00");
});

test("应税时点：赊销取合同约定收款日", () => {
  const p = resolveTaxablePoint({
    contract: { contracted_at: "2026-09-15T10:00:00+08:00", settlement_terms: "on_credit", payment_due_at: "2026-10-15T00:00:00+08:00" },
    dispatch: { dispatched_at: "2026-09-20T09:00:00+08:00" },
  });
  assert.equal(p.at, "2026-10-15T00:00:00+08:00");
});

test("应税时点：先开发票以开票日为准（更早）", () => {
  const p = resolveTaxablePoint({
    contract: { contracted_at: "2026-08-30T10:00:00+08:00", settlement_terms: "prepayment" },
    invoice: { issued_at: "2026-08-31T15:00:00+08:00" },
    dispatch: { dispatched_at: "2026-09-02T09:00:00+08:00" },
  });
  assert.equal(p.taxable_event, "invoice");
  assert.equal(p.at, "2026-08-31T15:00:00+08:00");
});

test("应税时点：事实未发生不可提前判定", () => {
  const p = resolveTaxablePoint({ contract: { contracted_at: "2026-09-01T10:00:00+08:00", settlement_terms: "prepayment" } });
  assert.equal(p.ok, false);
  assert.equal(p.determinable, false);
});

test("完整计税：价格×数量×税率并给出可重放解释", () => {
  const r = calculateTax({
    ruleRegistry: registry,
    ruleCode: "LI",
    category: "c",
    profile: { attributes: {} },
    contract: { contracted_at: "2026-09-04T10:00:00+08:00", contracted_price: 62, currency: "CNY", quantity: 100, unit: "只" },
    dispatch: { dispatched_at: "2026-09-07T09:00:00+08:00", quantity: 100, unit: "只" },
    invoice: { issued_at: "2026-09-08T11:00:00+08:00", invoice_price: 62, currency: "CNY" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.rule.rule_version, 2);
  assert.equal(r.tax_amount, 248); // 62×100×4%
  assert.equal(r.explanation.rule.rule_version, 2);
  assert.equal(r.explanation.computation.formula.includes("tax_basis_price"), true);
});

test("免税税额为 0 且解释中标注窗口", () => {
  const v2 = rule(2, {
    start: "2026-09-01",
    rate: 0.04,
    windows: [{ start: "2026-09-01", end: "2027-12-31", phase: "pilot", requires_evidence_types: [] }],
  });
  const reg = new Map([["LI", [v2]]]);
  const r = calculateTax({
    ruleRegistry: reg,
    ruleCode: "LI",
    category: "c",
    profile: { attributes: {} },
    evidence: [],
    contract: { contracted_at: "2026-09-08T10:00:00+08:00", contracted_price: 300, quantity: 100, currency: "CNY" },
    dispatch: { dispatched_at: "2026-09-09T09:00:00+08:00", quantity: 100 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.tax_amount, 0);
  assert.equal(r.exempt, true);
  assert.equal(r.explanation.rate.exemption.phase, "pilot");
});

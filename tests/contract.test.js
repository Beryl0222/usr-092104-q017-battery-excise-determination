import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { buildScenario } from "../scenarios/september-switch.js";
import { DeterminationService } from "../src/service.js";
import { projectRules, resolveForScope } from "../src/domain/rules.js";
import { projectClassifications, evaluateProfile } from "../src/domain/classification.js";
import { projectVouchers, planAdjustment, filingTotals, appendVoucherEvent } from "../src/domain/vouchers.js";
import { traceLot, traceSummary } from "../src/domain/audit.js";
import { event } from "../src/factory.js";

const tz = "+08:00";
const ms = (s) => Date.parse(`${s}${tz}`);

function assess(svc, args) {
  return svc.determine({ now: "2026-09-20T12:00:00+08:00", ...args });
}

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("信封校验：拒绝无时区时间与未授权签署角色", () => {
  const badTime = validateEvent({
    event_id: "x1", event_type: "RULE_EFFECTIVE", aggregate_type: "tax_rule",
    aggregate_id: "r", occurred_at: "2026-09-01T00:00:00", version: 1, summary: "x",
  });
  assert.ok(badTime.some((m) => m.includes("时区")));

  assert.throws(() => buildScenarioStore_sign("sales_manager"), /未授权/);
});

function buildScenarioStore_sign(role) {
  const { store } = buildScenario();
  store.append(event({
    type: "CLASSIFICATION_SIGNED", aggregateType: "battery_classification", aggregateId: "BC-X",
    occurredAt: "2026-09-12T10:00:00+08:00",
    payload: {
      profile_id: "P-HYBRID-MOD", decided_category: "hybrid_storage_module",
      signer_id: "u-1", signer_role: role, evidence_ids: ["EV-HYB-1"],
      signed_at: "2026-09-12T10:00:00+08:00",
    },
    summary: "越权签署",
  }));
}

test("九月切换：跨生效日按应税时点取 2% 与 4%", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);

  // A：8/28 签约（预收），9/2 出库发货 -> 税点 9/2，4%
  const a = assess(svc, {
    taxPointId: "TP-A", assessmentId: "A-A", lotId: "L-ION-A",
    contractId: "C-A", invoiceId: "INV-A", quantity: 10000, unitPriceExVat: 10,
  });
  assert.equal(a.result.ok, true);
  assert.equal(a.taxPoint.tax_point_ms, ms("2026-09-02T09:30:00"));
  assert.equal(a.result.rule.rate, 0.04);
  assert.equal(a.result.tax_amount, 4000);
  assert.match(a.result.formula, /4\.00%/);

  // B：8/31 先开票、9/1 才出库 -> 开票时点优先，落在旧版本 2%
  const b = assess(svc, {
    taxPointId: "TP-B", assessmentId: "A-B", lotId: "L-ION-B",
    contractId: "C-B", invoiceId: "INV-B", quantity: 4000, unitPriceExVat: 12,
  });
  assert.equal(b.taxPoint.tax_point_ms, ms("2026-08-31T15:00:00"));
  assert.equal(b.result.rule.version_no, "v2026-1");
  assert.equal(b.result.tax_amount, 960);
});

test("固态试制阶段性免税，且免税不得凭名称自动获得", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);

  // 真正的全固态：检验 0.95 + 过程记录齐备 -> 自动确认 -> 免税 0
  const s = assess(svc, {
    taxPointId: "TP-S", assessmentId: "A-S", lotId: "L-SOLID",
    contractId: "C-S", invoiceId: "INV-S", quantity: 200, unitPriceExVat: 500,
  });
  assert.equal(s.result.ok, true);
  assert.equal(s.result.rule.is_exempt, true);
  assert.equal(s.result.tax_amount, 0);
  assert.match(s.result.explanation.rule_application.interval, /2026-09-01/);

  // 改名产品：市场名含“全固态免税版”，但检验报告实测 0.01 与档案矛盾 -> 阻断
  const r = assess(svc, {
    taxPointId: "TP-R", assessmentId: "A-R", lotId: "L-RENAMED",
    contractId: "C-R", invoiceId: "INV-R", quantity: 5000, unitPriceExVat: 11,
  });
  assert.equal(r.result.ok, false);
  assert.ok(r.result.blockers.some((m) => m.includes("矛盾")));
  assert.equal(r.evaluation.contradictions[0].field, "solid_electrolyte_ratio");
});

test("半固态灰区与混合模组：列候选和缺失证据，签署前阻断，授权签署后计税", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);

  // 半固态：两个候选分类，无缺失证据但非唯一 -> 必须签署
  const cls = projectClassifications(store.replay());
  const semi = evaluateProfile(cls, "P-SEMI");
  assert.equal(semi.requires_signature, true);
  assert.deepEqual(semi.candidates.map((c) => c.category), ["solid_state_cell", "li_ion_cell"]);

  // 混合模组：边界产品，缺检验报告 -> 阻断并列出缺失证据
  const h0 = assess(svc, {
    taxPointId: "TP-H0", assessmentId: "A-H0", lotId: "L-HYBRID",
    contractId: "C-H", quantity: 10, unitPriceExVat: 200000,
  });
  assert.equal(h0.result.ok, false);
  assert.ok(h0.result.blockers.some((m) => m.includes("边界产品须授权人员签署")));
  assert.deepEqual(
    h0.evaluation.candidates.find((c) => c.category === "hybrid_storage_module").missing_evidence,
    ["inspection_report"],
  );

  // 技术部门补交检验报告，授权人员签署 -> 4%（模组税目），免税不自动延伸到混合模组
  store.append(event({
    type: "EVIDENCE_SUBMITTED", aggregateType: "evidence_bundle", aggregateId: "EV-HYB-2",
    occurredAt: "2026-09-12T09:00:00+08:00",
    payload: {
      profile_id: "P-HYBRID-MOD", evidence_type: "inspection_report", document_ref: "DOC-EV-HYB-2",
      issuer: "国家认可检验机构", verified: true,
      measured: { contains_solid_state_trial: true, solid_cell_mass_ratio: 0.18 },
    },
    summary: "混合模组检验报告（技术部门补充）",
  }));
  store.append(event({
    type: "CLASSIFICATION_SIGNED", aggregateType: "battery_classification", aggregateId: "BC-H",
    occurredAt: "2026-09-12T10:00:00+08:00",
    payload: {
      profile_id: "P-HYBRID-MOD", decided_category: "hybrid_storage_module",
      signer_id: "u-tax-7", signer_role: "authorized_classification_officer",
      evidence_ids: ["EV-HYB-1", "EV-HYB-2"], signed_at: "2026-09-12T10:00:00+08:00",
      reason: "固态电芯质量占比 18%，不符合全固态免税对象，整体按模组计税",
    },
    summary: "混合储能模组边界判定签署",
  }));

  const h1 = assess(svc, {
    taxPointId: "TP-H", assessmentId: "A-H", lotId: "L-HYBRID",
    contractId: "C-H", quantity: 10, unitPriceExVat: 200000,
  });
  assert.equal(h1.result.ok, true);
  assert.equal(h1.result.decided_category, "hybrid_storage_module");
  assert.equal(h1.result.rule.rate, 0.04);
  assert.equal(h1.result.rule.is_exempt, false);
  assert.equal(h1.result.tax_amount, 80000);
  assert.equal(h1.result.explanation.classification_evidence.basis.kind, "signed");
});

test("时间线可按时区与边界日期重放：2% / 4% / 免税窗口 / 到期回落", () => {
  const { store } = buildScenario();
  const at = (when) => projectRules(store.replay({ asOfMs: ms(when) + 1 }));

  const boundary = ms("2026-09-01T00:00:00"); // == 2026-08-31T16:00:00Z
  assert.equal(resolveForScope(at("2026-08-31T23:59:59"), "li_ion_cell", boundary - 1).rate, 0.02);
  assert.equal(resolveForScope(at("2026-09-01T00:00:00"), "li_ion_cell", boundary).rate, 0.04);

  // 同一绝对时刻，UTC 视角还是 8/31 16:00 —— 边界按发布时区的绝对时刻判定
  assert.equal(
    resolveForScope(at("2026-09-01T00:00:00"), "li_ion_cell", Date.parse("2026-08-31T16:00:00Z")).rate,
    0.04,
  );

  // 固态电芯：9 月起免税，2027-01-01 到期后自动回落 4%（无需人工切换）
  const rulesAll = projectRules(store.replay());
  assert.equal(
    resolveForScope(rulesAll, "solid_state_cell", ms("2026-12-31T23:59:59"), { preferExemption: true }).is_exempt,
    true,
  );
  const after = resolveForScope(rulesAll, "solid_state_cell", ms("2027-01-01T00:00:00"));
  assert.equal(after.rate, 0.04);
  assert.equal(after.is_exempt, false);
});

test("申报不可变：退货与折让以冲正/补充分录落入后续期间，禁止重复计税", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);

  const a = assess(svc, {
    taxPointId: "TP-A", assessmentId: "A-A", lotId: "L-ION-A",
    contractId: "C-A", invoiceId: "INV-A", quantity: 10000, unitPriceExVat: 10,
  });
  const b = assess(svc, {
    taxPointId: "TP-B", assessmentId: "A-B", lotId: "L-ION-B",
    contractId: "C-B", invoiceId: "INV-B", quantity: 4000, unitPriceExVat: 12,
  });
  store.append(a.taxPointEvent);
  store.append(a.assessmentEvent);
  store.append(b.taxPointEvent);
  store.append(b.assessmentEvent);

  // 原分录与九月申报
  appendVoucherEvent(store, event({
    type: "ENTRY_POSTED", aggregateType: "accounting_entry", aggregateId: "E-A",
    occurredAt: "2026-09-30T17:00:00+08:00",
    payload: { entry_id: "E-A", assessment_ids: ["A-A"], debit_account: "税金及附加", credit_account: "应交税费-应交消费税", amount: 4000 },
    summary: "九月计提 A",
  }));
  appendVoucherEvent(store, event({
    type: "ENTRY_POSTED", aggregateType: "accounting_entry", aggregateId: "E-B",
    occurredAt: "2026-09-30T17:00:00+08:00",
    payload: { entry_id: "E-B", assessment_ids: ["A-B"], debit_account: "税金及附加", credit_account: "应交税费-应交消费税", amount: 960 },
    summary: "九月计提 B",
  }));
  appendVoucherEvent(store, event({
    type: "FILING_SUBMITTED", aggregateType: "tax_filing", aggregateId: "F-2026-09",
    occurredAt: "2026-10-10T10:00:00+08:00",
    payload: { filing_id: "F-2026-09", period: "2026-09", assessment_ids: ["A-A", "A-B"], submitted_at: "2026-10-10T10:00:00+08:00" },
    summary: "九月申报",
  }));

  // 同一计税结论再次申报 -> 拒绝（不重复计税）
  assert.throws(() => appendVoucherEvent(store, event({
    type: "FILING_SUBMITTED", aggregateType: "tax_filing", aggregateId: "F-2026-09-DUP",
    occurredAt: "2026-10-11T10:00:00+08:00", version: 1,
    payload: { filing_id: "F-2026-09-DUP", period: "2026-09", assessment_ids: ["A-A"], submitted_at: "2026-10-11T10:00:00+08:00" },
    summary: "重复申报",
  })), /禁止重复计税/);

  // 十月：A 全部退货（仓库退货 + 红字发票），B 价格折让；先建更正所属的十月申报期
  store.append(event({
    type: "STOCK_RETURNED", aggregateType: "warehouse_inventory", aggregateId: "WH-L-ION-A",
    occurredAt: "2026-10-08T09:00:00+08:00",
    payload: { lot_id: "L-ION-A", quantity: 10000, at: "2026-10-08T09:00:00+08:00", ref: "RT-A" },
    summary: "A 批退货入库",
  }));
  store.append(event({
    type: "INVOICE_RED_ISSUED", aggregateType: "invoice", aggregateId: "INV-A-RED",
    occurredAt: "2026-10-08T10:00:00+08:00",
    payload: {
      invoice_id: "INV-A-RED", original_invoice_id: "INV-A",
      lines: [{ lot_id: "L-ION-A", quantity: 10000, unit_price_ex_vat: 10 }],
      amount_ex_vat: -100000, issued_at: "2026-10-08T10:00:00+08:00",
    },
    summary: "A 批红字发票",
  }));
  appendVoucherEvent(store, event({
    type: "FILING_SUBMITTED", aggregateType: "tax_filing", aggregateId: "F-2026-10",
    occurredAt: "2026-11-10T10:00:00+08:00",
    payload: {
      filing_id: "F-2026-10", period: "2026-10", assessment_ids: [],
      adjustment_entry_ids: ["ADJ-A-1", "ADJ-B-1"], submitted_at: "2026-11-10T10:00:00+08:00",
    },
    summary: "十月申报（更正期）",
  }));

  const vouchers0 = projectVouchers(store.replay());
  const entryA = vouchers0.entries.get("E-A");
  const ret = planAdjustment({
    originalEntry: entryA, recomputedTaxAmount: 0, reasonCode: "return",
    filingId: "F-2026-10", refEventId: "INV-A-RED", memo: "全部退货，冲回九月已计提",
  });
  assert.equal(ret.adjustment_type, "reversal");
  assert.equal(ret.amount, -4000);

  // 折让：48,000 -> 45,600，税额 960 -> 912，冲回 48
  const allowance = planAdjustment({
    originalEntry: vouchers0.entries.get("E-B"), recomputedTaxAmount: 912, reasonCode: "allowance",
    filingId: "F-2026-10", memo: "结算折让 5%",
  });
  assert.equal(allowance.amount, -48);

  // 复核补税方向：960 -> 1000 -> supplement
  const supplement = planAdjustment({
    originalEntry: vouchers0.entries.get("E-B"), recomputedTaxAmount: 1000, reasonCode: "review_reclass",
    filingId: "F-2026-10", memo: "复核补提",
  });
  assert.equal(supplement.adjustment_type, "supplement");
  assert.equal(supplement.amount, 40);

  appendVoucherEvent(store, event({
    type: "ENTRY_ADJUSTED", aggregateType: "accounting_entry", aggregateId: "E-A",
    occurredAt: "2026-10-31T17:00:00+08:00", version: 2,
    payload: { adjustment_entry_id: "ADJ-A-1", ...ret },
    summary: "退货冲正",
  }));
  appendVoucherEvent(store, event({
    type: "ENTRY_ADJUSTED", aggregateType: "accounting_entry", aggregateId: "E-B",
    occurredAt: "2026-10-31T17:00:00+08:00", version: 2,
    payload: { adjustment_entry_id: "ADJ-B-1", ...allowance },
    summary: "折让冲正",
  }));

  const vouchers = projectVouchers(store.replay());
  const sep = filingTotals(vouchers.filings.get("F-2026-09"), vouchers);
  const oct = filingTotals(vouchers.filings.get("F-2026-10"), vouchers);
  // 原申报数不变
  assert.equal(sep.original_declared, 4960);
  assert.equal(sep.adjustments_in_period, 0);
  // 更正落在十月
  assert.equal(oct.original_declared, 0);
  assert.equal(oct.adjustments_in_period, -4048);
  assert.equal(oct.net_payable, -4048);

  const eA = vouchers.entries.get("E-A");
  assert.equal(eA.amount, 4000); // 原分录金额未被覆盖
  assert.equal(eA.adjustments[0].reason_code, "return");
  assert.equal(eA.adjustments[0].original_entry_id, "E-A");
});

test("外购已税电芯连续生产：扣除以凭证为限并封顶", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);
  const p = assess(svc, {
    taxPointId: "TP-P", assessmentId: "A-P", lotId: "L-PACK",
    contractId: "C-P", invoiceId: "INV-P", quantity: 100, unitPriceExVat: 30000,
    creditInputs: [
      { lot_id: "L-ION-C", quantity: 4000, tax_paid: 3000, voucher_ref: "V-UP-1" },
      { lot_id: "L-ION-C", quantity: 4000, tax_paid: 999999, voucher_ref: "V-BOGEUS" }, // 超额凭证
    ],
  });
  assert.equal(p.result.ok, true);
  assert.equal(p.result.price.taxable_price, 3_000_000);
  // 合计扣除凭证 1,002,999 超过应纳税额 120,000，封顶 120,000
  assert.equal(p.result.credit.total, 1_002_999);
  assert.equal(p.result.credit.applied, 120_000);
  assert.equal(p.result.credit.clipped, true);
  assert.equal(p.result.tax_amount, 0);
});

test("审计：从整车电池包递归追到电芯批次、申报与更正", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);

  const p = assess(svc, {
    taxPointId: "TP-P", assessmentId: "A-P", lotId: "L-PACK",
    contractId: "C-P", invoiceId: "INV-P", quantity: 100, unitPriceExVat: 30000,
  });
  store.append(p.taxPointEvent);
  store.append(p.assessmentEvent);
  appendVoucherEvent(store, event({
    type: "ENTRY_POSTED", aggregateType: "accounting_entry", aggregateId: "E-P",
    occurredAt: "2026-09-30T17:00:00+08:00",
    payload: { entry_id: "E-P", assessment_ids: ["A-P"], debit_account: "税金及附加", credit_account: "应交税费-应交消费税", amount: 120000 },
    summary: "电池包九月计提",
  }));
  appendVoucherEvent(store, event({
    type: "FILING_SUBMITTED", aggregateType: "tax_filing", aggregateId: "F-2026-09",
    occurredAt: "2026-10-10T10:00:00+08:00",
    payload: { filing_id: "F-2026-09", period: "2026-09", assessment_ids: ["A-P"], submitted_at: "2026-10-10T10:00:00+08:00" },
    summary: "九月申报",
  }));
  appendVoucherEvent(store, event({
    type: "FILING_SUBMITTED", aggregateType: "tax_filing", aggregateId: "F-2026-10",
    occurredAt: "2026-11-10T10:00:00+08:00",
    payload: {
      filing_id: "F-2026-10", period: "2026-10", assessment_ids: [],
      adjustment_entry_ids: ["ADJ-P-1"], submitted_at: "2026-11-10T10:00:00+08:00",
    },
    summary: "十月更正期",
  }));
  appendVoucherEvent(store, event({
    type: "ENTRY_ADJUSTED", aggregateType: "accounting_entry", aggregateId: "E-P",
    occurredAt: "2026-10-31T17:00:00+08:00", version: 2,
    payload: {
      adjustment_entry_id: "ADJ-P-1", adjustment_type: "reversal", reason_code: "use_change",
      original_entry_id: "E-P", filing_id: "F-2026-10", amount: -12000,
      memo: "10 个电池包转用于连续生产，冲回对应税额",
    },
    summary: "用途变化冲正",
  }));

  const ops = svc.projections().operations;
  const vouchers = projectVouchers(store.replay());
  const trace = traceLot("L-PACK", ops, vouchers);

  assert.equal(trace.leaf, false);
  assert.deepEqual(trace.components.map((c) => c.lot_id).sort(), ["L-ION-C", "L-SOLID-B"]);
  const assessed = trace.assessments[0];
  assert.equal(assessed.tax_amount, 120000);
  assert.equal(assessed.filing.period, "2026-09");
  assert.equal(assessed.entry.adjustments[0].reason_code, "use_change");
  assert.equal(assessed.entry.net_amount, 108000);
  assert.equal(assessed.entry.amount, 120000); // 原数保留

  const summary = traceSummary(trace);
  assert.equal(summary.declared_total, 120000);
  assert.equal(summary.declared_net_total, 108000);
  assert.equal(summary.declared_at.length, 1); // 子批次未对外销售计税，不重复计
});

test("解释对象可回答：用了哪部法规、哪些证据、什么价格、什么时点", () => {
  const { store } = buildScenario();
  const svc = new DeterminationService(store);
  const a = assess(svc, {
    taxPointId: "TP-A", assessmentId: "A-A", lotId: "L-ION-A",
    contractId: "C-A", invoiceId: "INV-A", quantity: 10000, unitPriceExVat: 10,
  });
  const ex = a.result.explanation;
  assert.equal(ex.rule_application.chosen_rule, "R-LI-CELL@v2026-2");
  assert.match(ex.rule_application.citation, /九月/);
  assert.equal(ex.classification_evidence.category, "li_ion_cell");
  assert.equal(ex.classification_evidence.basis.kind, "automatic");
  assert.match(ex.tax_point.basis, /出库/);
  assert.equal(ex.price_basis.includes("不含增值税"), true);
  assert.ok(ex.formula_text.length > 0);
});

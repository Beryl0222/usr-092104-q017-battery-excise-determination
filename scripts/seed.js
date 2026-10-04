// 端到端种子场景：九月政策切换下的锂离子电芯、固态试制、混合储能模组。
// 运行：node scripts/seed.js [输出jsonl路径]
// 所有事件经 TaxService 校验后落盘，可作为演示与手工重放数据。

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EventStore } from "../src/application/eventStore.js";
import { TaxService, Role } from "../src/application/taxService.js";

const actors = {
  admin: { id: "u-admin", roles: [Role.RULE_ADMIN] },
  officer: { id: "u-officer-li", roles: [Role.TAX_OFFICER] },
  finance: { id: "u-finance-wang", roles: [Role.FINANCE] },
  technical: { id: "u-tech-chen", roles: [Role.TECHNICAL] },
  warehouse: { id: "u-wh-robot", roles: [Role.WAREHOUSE] },
};

// 八月旧规：锂离子 2%；混合模组统一 2%。
const ruleV1 = {
  rule_code: "LI_EXCISE",
  rule_version: 202601,
  title: "锂离子电池消费税适用规则（年初版）",
  legal_basis: "财税公告样例-2026-01",
  effective_start: "2026-01-01",
  effective_end: "2026-08-31",
  time_zone: "Asia/Shanghai",
  replaces_version: null,
  categories: [
    {
      category: "lithium_ion_cell",
      title: "锂离子电芯",
      rate: 0.02,
      criteria: {
        requires: [
          { attribute: "electrolyte_state", op: "eq", value: "liquid" },
          { attribute: "form", op: "eq", value: "cell" },
          { attribute: "cathode_family", op: "in", value: ["NMC", "LFP"] },
        ],
        required_attributes: ["electrolyte_state", "energy_density_wh_per_kg", "cathode_family"],
        required_evidence_types: ["test_report"],
      },
    },
    {
      category: "hybrid_storage_module",
      title: "混合储能模组",
      rate: 0.02,
      criteria: {
        requires: [
          { attribute: "form", op: "eq", value: "module" },
          { attribute: "chemistry_mix", op: "eq", value: "hybrid_lithium_solid" },
        ],
        required_attributes: ["energy_density_wh_per_kg", "chemistry_mix"],
        required_evidence_types: ["test_report", "composition_bom"],
      },
    },
  ],
};

// 九月新规：锂离子升至 4%；新增固态税目与试制免税窗口（需资质）；混合模组 2%/4% 阶梯。
const ruleV2 = {
  rule_code: "LI_EXCISE",
  rule_version: 202609,
  title: "锂离子电池等产品消费税适用规则（九月版）",
  legal_basis: "财税公告样例-2026-09",
  effective_start: "2026-09-01",
  effective_end: null,
  time_zone: "Asia/Shanghai",
  replaces_version: 202601,
  rounding: { decimals: 2, mode: "half_up" },
  categories: [
    {
      category: "lithium_ion_cell",
      title: "锂离子电芯",
      rate: 0.04,
      criteria: ruleV1.categories[0].criteria,
    },
    {
      category: "solid_state_cell",
      title: "固态电池试制产品（电芯）",
      rate: 0.04,
      exemption_windows: [
        {
          start: "2026-09-01",
          end: "2027-12-31",
          phase: "pilot_exemption",
          requires_evidence_types: ["pilot_qualification"],
        },
      ],
      criteria: {
        requires: [
          { attribute: "electrolyte_state", op: "eq", value: "solid" },
          { attribute: "form", op: "eq", value: "cell" },
        ],
        required_attributes: ["electrolyte_state", "energy_density_wh_per_kg"],
        required_evidence_types: ["test_report"],
      },
    },
    {
      category: "hybrid_storage_module",
      title: "混合储能模组",
      rate: 0.04,
      thresholds: [
        { conditions: [{ attribute: "energy_density_wh_per_kg", op: "lte", value: 300 }], rate: 0.02 },
        { conditions: [], rate: 0.04 },
      ],
      criteria: ruleV1.categories[1].criteria,
    },
  ],
};

async function main() {
  const out = process.argv[2] || "data/eventlog.jsonl";
  const store = new EventStore();
  let tick = Date.parse("2026-08-20T09:00:00+08:00");
  const clock = () => new Date(tick);
  const svc = new TaxService(store, { now: clock });
  const advance = (iso) => {
    tick = Date.parse(iso);
  };

  // 1) 法规版本
  advance("2025-12-25T10:00:00+08:00");
  await svc.registerRule(actors.admin, { ...ruleV1, occurred_at: "2025-12-25T10:00:00+08:00" });
  advance("2026-08-20T09:00:00+08:00");
  await svc.registerRule(actors.admin, { ...ruleV2, occurred_at: "2026-08-20T09:00:00+08:00" });

  // 2) 产品档案 + 证据
  await svc.registerProfile(actors.technical, {
    profile_id: "P-LI-280",
    market_name: "方型锂离子电芯 280Wh/kg",
    declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "liquid", cathode_family: "NMC", energy_density_wh_per_kg: 280 },
    supplier_id: "SUP-01",
    occurred_at: "2026-08-21T09:00:00+08:00",
  });
  await svc.attachEvidence(actors.technical, {
    profile_id: "P-LI-280",
    evidence_type: "test_report",
    evidence_ref: "TR-LI-280-001",
    issuer: "国家电池检验中心",
    issued_at: "2026-08-18T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "energy_density_wh_per_kg", "cathode_family", "form"],
    occurred_at: "2026-08-21T09:30:00+08:00",
  });

  await svc.registerProfile(actors.technical, {
    profile_id: "P-SS-PILOT",
    market_name: "硫化物全固态试制电芯",
    declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "solid", energy_density_wh_per_kg: 410 },
    supplier_id: "SUP-01",
    occurred_at: "2026-08-22T09:00:00+08:00",
  });
  await svc.attachEvidence(actors.technical, {
    profile_id: "P-SS-PILOT",
    evidence_type: "test_report",
    evidence_ref: "TR-SS-410-007",
    issuer: "国家电池检验中心",
    issued_at: "2026-08-19T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "energy_density_wh_per_kg", "form"],
    occurred_at: "2026-08-22T09:30:00+08:00",
  });
  await svc.attachEvidence(actors.officer, {
    profile_id: "P-SS-PILOT",
    evidence_type: "pilot_qualification",
    evidence_ref: "PILOT-NDRC-2026-118",
    issuer: "工业和信息化主管部门（样例）",
    issued_at: "2026-08-28T00:00:00+08:00",
    attributes_verified: [],
    valid_until: "2027-12-31T23:59:59+08:00",
    occurred_at: "2026-08-28T14:00:00+08:00",
  });

  // 混合储能模组：低能量密度档（2%）与高能量密度档（4%）
  for (const [pid, density] of [["P-HM-290", 290], ["P-HM-350", 350]]) {
    await svc.registerProfile(actors.technical, {
      profile_id: pid,
      market_name: `混合储能模组 ${density}Wh/kg`,
      declared_form: "module",
      attributes: { form: "module", chemistry_mix: "hybrid_lithium_solid", energy_density_wh_per_kg: density },
      supplier_id: "SUP-02",
      occurred_at: "2026-08-23T09:00:00+08:00",
    });
    await svc.attachEvidence(actors.technical, {
      profile_id: pid,
      evidence_type: "test_report",
      evidence_ref: `TR-HM-${density}-002`,
      issuer: "国家电池检验中心",
      issued_at: "2026-08-19T00:00:00+08:00",
      attributes_verified: ["energy_density_wh_per_kg", "chemistry_mix", "form"],
      occurred_at: "2026-08-23T09:30:00+08:00",
    });
    await svc.attachEvidence(actors.technical, {
      profile_id: pid,
      evidence_type: "composition_bom",
      evidence_ref: `BOM-HM-${density}-A9`,
      issuer: "本厂技术部",
      issued_at: "2026-08-20T00:00:00+08:00",
      attributes_verified: ["chemistry_mix"],
      occurred_at: "2026-08-23T10:00:00+08:00",
    });
  }

  // 边界产品：半固态，无法自动认定
  await svc.registerProfile(actors.technical, {
    profile_id: "P-SEMI-BORDER",
    market_name: "半固态电芯（边界）",
    declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "semi_solid", energy_density_wh_per_kg: 330 },
    supplier_id: "SUP-03",
    occurred_at: "2026-08-24T09:00:00+08:00",
  });
  await svc.attachEvidence(actors.technical, {
    profile_id: "P-SEMI-BORDER",
    evidence_type: "test_report",
    evidence_ref: "TR-SEMI-330-003",
    issuer: "国家电池检验中心",
    issued_at: "2026-08-21T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "energy_density_wh_per_kg", "form"],
    occurred_at: "2026-08-24T09:30:00+08:00",
  });

  // 改名攻击：液态锂电芯改名为"固态试制免税"
  await svc.registerProfile(actors.technical, {
    profile_id: "P-FAKE-SS",
    market_name: "普通锂离子电芯",
    declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "liquid", cathode_family: "LFP", energy_density_wh_per_kg: 250 },
    supplier_id: "SUP-99",
    occurred_at: "2026-08-25T09:00:00+08:00",
  });
  await svc.attachEvidence(actors.technical, {
    profile_id: "P-FAKE-SS",
    evidence_type: "test_report",
    evidence_ref: "TR-FAKE-250-009",
    issuer: "国家电池检验中心",
    issued_at: "2026-08-21T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "energy_density_wh_per_kg", "cathode_family", "form"],
    occurred_at: "2026-08-25T09:30:00+08:00",
  });
  await svc.renameProfile(actors.finance, {
    profile_id: "P-FAKE-SS",
    new_name: "全固态试制免税电芯（供应商改名）",
    reason: "供应商九月后自行更改市场名称",
    renamed_at: "2026-09-03T08:00:00+08:00",
    occurred_at: "2026-09-03T08:00:00+08:00",
  });

  // 3) 边界产品授权签署：税务人员按证据签署为锂离子电芯
  await svc.signClassification(actors.officer, {
    profile_id: "P-SEMI-BORDER",
    category: "lithium_ion_cell",
    evidence_refs: ["TR-SEMI-330-003"],
    signed_at: "2026-08-29T10:00:00+08:00",
    valid_from: "2026-09-01",
    note: "半固态电解质仍属液态体系，边界判定按锂离子电芯征税，逐批复核。",
    occurred_at: "2026-08-29T10:00:00+08:00",
  });

  // 4) 批次与 BOM
  await svc.recordLot(actors.warehouse, { lot_id: "L-CELL-0830", profile_id: "P-LI-280", produced_at: "2026-08-30T08:00:00+08:00", quantity: 10000, unit: "只", occurred_at: "2026-08-30T08:00:00+08:00" });
  await svc.completeLot(actors.warehouse, { lot_id: "L-CELL-0830", completed_at: "2026-08-31T16:00:00+08:00", warehouse_event_id: "WH-IN-20260831-01", occurred_at: "2026-08-31T16:00:00+08:00" });

  await svc.recordLot(actors.warehouse, { lot_id: "L-CELL-0902", profile_id: "P-LI-280", produced_at: "2026-09-02T08:00:00+08:00", quantity: 20000, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  await svc.completeLot(actors.warehouse, { lot_id: "L-CELL-0902", completed_at: "2026-09-03T11:00:00+08:00", warehouse_event_id: "WH-IN-20260903-01", occurred_at: "2026-09-03T11:00:00+08:00" });

  await svc.recordLot(actors.warehouse, { lot_id: "L-SS-0905", profile_id: "P-SS-PILOT", produced_at: "2026-09-05T08:00:00+08:00", quantity: 200, unit: "只", occurred_at: "2026-09-05T08:00:00+08:00" });
  await svc.completeLot(actors.warehouse, { lot_id: "L-SS-0905", completed_at: "2026-09-06T10:00:00+08:00", warehouse_event_id: "WH-IN-20260906-02", occurred_at: "2026-09-06T10:00:00+08:00" });

  await svc.recordLot(actors.warehouse, { lot_id: "L-HM290-0910", profile_id: "P-HM-290", produced_at: "2026-09-10T08:00:00+08:00", quantity: 50, unit: "套", occurred_at: "2026-09-10T08:00:00+08:00" });
  await svc.recordLot(actors.warehouse, { lot_id: "L-HM350-0912", profile_id: "P-HM-350", produced_at: "2026-09-12T08:00:00+08:00", quantity: 30, unit: "套", occurred_at: "2026-09-12T08:00:00+08:00" });
  // 模组 BOM：各耗用 4000 只液态电芯与 40 只固态试制电芯
  await svc.linkBom(actors.warehouse, { lot_id: "L-CELL-0902", module_lot_id: "L-HM290-0910", quantity_consumed: 4000, unit: "只", occurred_at: "2026-09-10T12:00:00+08:00" });
  await svc.linkBom(actors.warehouse, { lot_id: "L-SS-0905", module_lot_id: "L-HM290-0910", quantity_consumed: 40, unit: "只", occurred_at: "2026-09-10T12:05:00+08:00" });
  await svc.linkBom(actors.warehouse, { lot_id: "L-CELL-0902", module_lot_id: "L-HM350-0912", quantity_consumed: 2400, unit: "只", occurred_at: "2026-09-12T12:00:00+08:00" });
  await svc.linkBom(actors.warehouse, { lot_id: "L-SS-0905", module_lot_id: "L-HM350-0912", quantity_consumed: 24, unit: "只", occurred_at: "2026-09-12T12:05:00+08:00" });

  await svc.recordLot(actors.warehouse, { lot_id: "L-FAKE-0908", profile_id: "P-FAKE-SS", produced_at: "2026-09-08T08:00:00+08:00", quantity: 800, unit: "只", occurred_at: "2026-09-08T08:00:00+08:00" });

  await svc.recordLot(actors.warehouse, { lot_id: "L-BORDER-0909", profile_id: "P-SEMI-BORDER", produced_at: "2026-09-09T08:00:00+08:00", quantity: 600, unit: "只", occurred_at: "2026-09-09T08:00:00+08:00" });

  // 5) 销售：合同/开票/出库跨生效日
  // A：8/31 先开票（旧规 2%），9/2 才出库
  await svc.recordContract(actors.finance, {
    supply_id: "S-A", lot_id: "L-CELL-0830", profile_id: "P-LI-280", counterparty: "整车厂甲",
    contracted_at: "2026-08-30T10:00:00+08:00", contracted_price: 60, currency: "CNY", quantity: 10000, unit: "只",
    settlement_terms: "prepayment", occurred_at: "2026-08-30T10:00:00+08:00",
  });
  await svc.issueInvoice(actors.finance, {
    invoice_id: "INV-A", supply_id: "S-A", issued_at: "2026-08-31T15:00:00+08:00",
    invoice_price: 60, currency: "CNY", invoice_number: "FP20260831A", occurred_at: "2026-08-31T15:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-A", dispatched_at: "2026-09-02T09:00:00+08:00", quantity: 10000, unit: "只",
    warehouse_event_id: "WH-OUT-20260902-01", occurred_at: "2026-09-02T09:00:00+08:00",
  });
  const entryA = await svc.calculateForSupply(actors.finance, { supply_id: "S-A", occurred_at: "2026-09-02T10:00:00+08:00" });

  // B：9 月合同 + 出库（新规 4%）
  await svc.recordContract(actors.finance, {
    supply_id: "S-B", lot_id: "L-CELL-0902", profile_id: "P-LI-280", counterparty: "储能集成商乙",
    contracted_at: "2026-09-04T10:00:00+08:00", contracted_price: 62, currency: "CNY", quantity: 5000, unit: "只",
    occurred_at: "2026-09-04T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-B", dispatched_at: "2026-09-07T09:00:00+08:00", quantity: 5000, unit: "只",
    warehouse_event_id: "WH-OUT-20260907-01", occurred_at: "2026-09-07T09:00:00+08:00",
  });
  await svc.issueInvoice(actors.finance, {
    invoice_id: "INV-B", supply_id: "S-B", issued_at: "2026-09-08T11:00:00+08:00",
    invoice_price: 62, currency: "CNY", invoice_number: "FP20260908B", occurred_at: "2026-09-08T11:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-B", occurred_at: "2026-09-08T14:00:00+08:00" });

  // C：固态试制 9 月出货 → 窗口内且有资质 → 免税 0
  await svc.recordContract(actors.finance, {
    supply_id: "S-C", lot_id: "L-SS-0905", profile_id: "P-SS-PILOT", counterparty: "科研合作方丙",
    contracted_at: "2026-09-08T10:00:00+08:00", contracted_price: 300, currency: "CNY", quantity: 100, unit: "只",
    occurred_at: "2026-09-08T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-C", dispatched_at: "2026-09-09T09:00:00+08:00", quantity: 100, unit: "只",
    warehouse_event_id: "WH-OUT-20260909-01", occurred_at: "2026-09-09T09:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-C", occurred_at: "2026-09-09T10:00:00+08:00" });

  // D：改名的液态电芯 9 月出货 → 仍按锂离子 4%，不获免税
  await svc.recordContract(actors.finance, {
    supply_id: "S-D", lot_id: "L-FAKE-0908", profile_id: "P-FAKE-SS", counterparty: "贸易商丁",
    contracted_at: "2026-09-09T10:00:00+08:00", contracted_price: 40, currency: "CNY", quantity: 800, unit: "只",
    occurred_at: "2026-09-09T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-D", dispatched_at: "2026-09-11T09:00:00+08:00", quantity: 800, unit: "只",
    warehouse_event_id: "WH-OUT-20260911-01", occurred_at: "2026-09-11T09:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-D", occurred_at: "2026-09-11T10:00:00+08:00" });

  // E：边界产品（已签署为锂离子）9 月出货 → 4%
  await svc.recordContract(actors.finance, {
    supply_id: "S-E", lot_id: "L-BORDER-0909", profile_id: "P-SEMI-BORDER", counterparty: "整车厂戊",
    contracted_at: "2026-09-10T10:00:00+08:00", contracted_price: 90, currency: "CNY", quantity: 600, unit: "只",
    occurred_at: "2026-09-10T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-E", dispatched_at: "2026-09-12T09:00:00+08:00", quantity: 600, unit: "只",
    warehouse_event_id: "WH-OUT-20260912-01", occurred_at: "2026-09-12T09:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-E", occurred_at: "2026-09-12T10:00:00+08:00" });

  // F：赊销合同约定 10/15 收款，9 月已发货（演示应税时点为约定收款日——落在新规区间）
  await svc.recordContract(actors.finance, {
    supply_id: "S-F", lot_id: "L-HM290-0910", profile_id: "P-HM-290", counterparty: "储能电站己",
    contracted_at: "2026-09-15T10:00:00+08:00", contracted_price: 200000, currency: "CNY", quantity: 10, unit: "套",
    settlement_terms: "on_credit", payment_due_at: "2026-10-15T00:00:00+08:00",
    occurred_at: "2026-09-15T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-F", dispatched_at: "2026-09-20T09:00:00+08:00", quantity: 10, unit: "套",
    warehouse_event_id: "WH-OUT-20260920-01", occurred_at: "2026-09-20T09:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-F", as_of: "2026-10-16T09:00:00+08:00", occurred_at: "2026-10-16T09:00:00+08:00" });

  // G：高密度模组 9 月即时销售 → 4% 档
  await svc.recordContract(actors.finance, {
    supply_id: "S-G", lot_id: "L-HM350-0912", profile_id: "P-HM-350", counterparty: "储能集成商庚",
    contracted_at: "2026-09-16T10:00:00+08:00", contracted_price: 260000, currency: "CNY", quantity: 6, unit: "套",
    occurred_at: "2026-09-16T10:00:00+08:00",
  });
  await svc.dispatch(actors.warehouse, {
    supply_id: "S-G", dispatched_at: "2026-09-18T09:00:00+08:00", quantity: 6, unit: "套",
    warehouse_event_id: "WH-OUT-20260918-01", occurred_at: "2026-09-18T09:00:00+08:00",
  });
  await svc.calculateForSupply(actors.finance, { supply_id: "S-G", occurred_at: "2026-09-18T10:00:00+08:00" });

  // 6) 退货与折让：S-B 部分退货 1000 只 → 按比例冲正；S-G 销售折让 5% → 冲正
  const state0 = svc.state();
  const entryB = state0.entriesBySupply.get("S-B").map((id) => state0.entries.get(id)).find((e) => e.kind === "initial");
  await svc.reverseEntry(actors.finance, {
    entry_id: entryB.entry_id,
    reason_code: "return",
    reason_ref: "RET-2026-09-22-01",
    tax_amount: -Math.round(entryB.tax_amount * (1000 / 5000) * 100) / 100,
    quantity: 1000,
    reversed_at: "2026-09-22T15:00:00+08:00",
    occurred_at: "2026-09-22T15:00:00+08:00",
  });
  const state1 = svc.state();
  const entryG = state1.entriesBySupply.get("S-G").map((id) => state1.entries.get(id)).find((e) => e.kind === "initial");
  await svc.reverseEntry(actors.finance, {
    entry_id: entryG.entry_id,
    reason_code: "allowance",
    reason_ref: "CN-2026-09-25-01",
    tax_amount: -Math.round(entryG.tax_amount * 0.05 * 100) / 100,
    reversed_at: "2026-09-25T15:00:00+08:00",
    occurred_at: "2026-09-25T15:00:00+08:00",
  });

  // 7) 税务复核
  await svc.recordReview(actors.officer, {
    entry_ids: [entryA.determination.entry_id, entryB.entry_id],
    conclusion: "confirmed",
    reviewed_at: "2026-09-28T10:00:00+08:00",
    note: "跨生效日两笔：先开票适用八月规 2%，九月发货适用九月规 4%，时点与版本均无误。",
    occurred_at: "2026-09-28T10:00:00+08:00",
  });

  // 8) 九月申报批次（锁定）。含全部初始分录与冲正分录（净额申报）。
  const state2 = svc.state();
  const septemberEntries = [...state2.entries.values()]
    .filter((e) => {
      const day = e.explanation?.rule?.local_taxable_day || (e.taxable_event_at || "").slice(0, 10);
      return day >= "2026-09-01" && day <= "2026-09-30";
    })
    .map((e) => e.entry_id);
  await svc.submitFiling(actors.finance, {
    filing_id: "FILING-2026-09",
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    entry_ids: septemberEntries,
    submitted_at: "2026-10-10T09:00:00+08:00",
    occurred_at: "2026-10-10T09:00:00+08:00",
  });
  await svc.settleFiling(actors.finance, {
    filing_id: "FILING-2026-09", settled_at: "2026-10-12T09:00:00+08:00", reference: "PAY-20261012-001",
    occurred_at: "2026-10-12T09:00:00+08:00",
  });

  // 落盘
  await mkdir(dirname(out), { recursive: true });
  await writeFile(resolve(out), store.all().map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  // 摘要
  const final = svc.state();
  const summary = [...final.entries.values()].map((e) => ({
    entry_id: e.entry_id,
    kind: e.kind,
    lot_id: e.lot_id,
    category: e.category || (final.entries.get(e.reverses)?.category) || "-",
    rate: e.rate ?? "-",
    tax_amount: e.tax_amount,
  }));
  console.log(JSON.stringify({ event_count: store.all().length, output: out, entries: summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

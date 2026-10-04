// 九月政策切换联调场景：
//  - 锂离子电芯税率 2% -> 4%（2026-09-01 00:00 +08:00 切换，左闭右开）
//  - 固态试制电芯阶段性免税 2026-09-01 起、2027-01-01 到期
//  - 混合储能模组（边界产品）证据不全 -> 阻断；授权签署后可计税
//  - 供应商改名产品（市场名“全固态免税版”，实测液态锂离子）不能获得免税
//  - 跨生效日的合同/入库/开票/出库按应税时点取版本
//  - 申报后退货、折让、复核用冲正/补充分录落在后续期间
//  - 整车电池包可递归追溯到电芯批次与已申报税额

import { EventStore } from "../src/domain/store.js";
import { event } from "../src/factory.js";

const TZ = "+08:00";
const ts = (s) => `${s}${TZ}`;

export function buildScenario() {
  const store = new EventStore();
  const append = (e) => store.append(e);

  // ---------- 法规版本（发布于 8 月 15 日） ----------
  const pub = "2026-08-15T10:00:00+08:00";
  append(event({
    type: "RULE_VERSION_PUBLISHED", aggregateType: "tax_rule", aggregateId: "R-LI-CELL",
    occurredAt: pub, version: 1,
    payload: {
      rule_id: "R-LI-CELL", rule_version_no: "v2026-1", citation: "锂电消费税公告 2025 年版（1-8月）",
      tax_scope: "li_ion_cell", applies_scopes: ["li_ion_cell", "solid_state_cell"], rate: 0.02, is_exempt: false,
      effective_from: ts("2026-01-01T00:00:00"), effective_to: ts("2026-09-01T00:00:00"), published_at: pub,
    },
    summary: "锂离子电芯 2% 版本（九月前）",
  }));
  append(event({
    type: "RULE_VERSION_PUBLISHED", aggregateType: "tax_rule", aggregateId: "R-LI-CELL",
    occurredAt: pub, version: 2,
    payload: {
      rule_id: "R-LI-CELL", rule_version_no: "v2026-2", citation: "锂电消费税公告 2026 年修订（九月起）",
      tax_scope: "li_ion_cell", applies_scopes: ["li_ion_cell", "solid_state_cell"], rate: 0.04, is_exempt: false,
      effective_from: ts("2026-09-01T00:00:00"), effective_to: null, published_at: pub,
    },
    summary: "锂离子电芯 4% 版本（九月起）",
  }));
  append(event({
    type: "RULE_VERSION_PUBLISHED", aggregateType: "tax_rule", aggregateId: "R-LI-MODULE",
    occurredAt: pub, version: 1,
    payload: {
      rule_id: "R-LI-MODULE", rule_version_no: "v2026-1", citation: "锂电消费税公告 2025 年版（1-8月）",
      tax_scope: "li_ion_module", applies_scopes: ["li_ion_module", "hybrid_storage_module"], rate: 0.02, is_exempt: false,
      effective_from: ts("2026-01-01T00:00:00"), effective_to: ts("2026-09-01T00:00:00"), published_at: pub,
    },
    summary: "模组 2% 版本（九月前）",
  }));
  append(event({
    type: "RULE_VERSION_PUBLISHED", aggregateType: "tax_rule", aggregateId: "R-LI-MODULE",
    occurredAt: pub, version: 2,
    payload: {
      rule_id: "R-LI-MODULE", rule_version_no: "v2026-2", citation: "锂电消费税公告 2026 年修订（九月起）",
      tax_scope: "li_ion_module", applies_scopes: ["li_ion_module", "hybrid_storage_module"], rate: 0.04, is_exempt: false,
      effective_from: ts("2026-09-01T00:00:00"), effective_to: null, published_at: pub,
    },
    summary: "模组 4% 版本（九月起）",
  }));
  append(event({
    type: "RULE_VERSION_PUBLISHED", aggregateType: "tax_rule", aggregateId: "R-SOLID-TRIAL",
    occurredAt: pub, version: 1,
    payload: {
      rule_id: "R-SOLID-TRIAL", rule_version_no: "v2026-trial", citation: "固态电池试制产品阶段性免税通知",
      tax_scope: "solid_state_cell", rate: 0, is_exempt: true,
      effective_from: ts("2026-09-01T00:00:00"), effective_to: ts("2027-01-01T00:00:00"), published_at: pub,
    },
    summary: "固态试制电芯阶段性免税（2026 年底到期）",
  }));

  // ---------- 技术档案（市场名称只留档，不参与判定） ----------
  const registerProfile = (id, attrs, marketNames) => append(event({
    type: "TECHNICAL_PROFILE_REGISTERED", aggregateType: "technical_profile", aggregateId: id,
    occurredAt: ts("2026-08-20T09:00:00"),
    payload: { profile_id: id, attributes: attrs, market_names: marketNames },
    summary: `登记技术档案 ${id}`,
  }));

  registerProfile("P-ION", { form_factor: "cell", electrochemistry: "liquid_li_ion", solid_electrolyte_ratio: 0.05 },
    ["磷酸铁锂动力电芯"]);
  registerProfile("P-SOLID", { form_factor: "cell", electrochemistry: "solid_state", solid_electrolyte_ratio: 0.96 },
    ["全固态试制电芯 A 型"]);
  registerProfile("P-SEMI", { form_factor: "cell", electrochemistry: "hybrid", solid_electrolyte_ratio: 0.62 },
    ["半固态电芯"]);
  registerProfile("P-HYBRID-MOD", {
    form_factor: "module", application: "storage", contains_solid_state_trial: true,
  }, ["混合储能模组 2MWh"]);
  registerProfile("P-RENAMED", { form_factor: "cell", electrochemistry: "liquid_li_ion", solid_electrolyte_ratio: 0.04 },
    ["磷酸铁锂电芯", "全固态免税版电芯"]); // 供应商九月后改名，企图蹭免税
  registerProfile("P-PACK", { form_factor: "module", application: "ev" }, ["整车动力电池包"]);

  // ---------- 证据 ----------
  const evidence = (id, profileId, type, measured = null, at = "2026-08-21T09:00:00") => append(event({
    type: "EVIDENCE_SUBMITTED", aggregateType: "evidence_bundle", aggregateId: id,
    occurredAt: ts(at),
    payload: {
      profile_id: profileId, evidence_type: type, document_ref: `DOC-${id}`,
      issuer: "国家认可检验机构", verified: true, measured,
    },
    summary: `证据 ${id}（${type}）`,
  }));

  evidence("EV-ION-1", "P-ION", "inspection_report", { solid_electrolyte_ratio: 0.05 });
  evidence("EV-SOLID-1", "P-SOLID", "inspection_report", { solid_electrolyte_ratio: 0.95 });
  evidence("EV-SOLID-2", "P-SOLID", "process_record");
  evidence("EV-HYB-1", "P-HYBRID-MOD", "bom_composition");
  // 混合模组起初只有 BOM、缺检验报告，用于演示“列出缺失证据、阻断计税”。
  evidence("EV-REN-1", "P-RENAMED", "inspection_report", { solid_electrolyte_ratio: 0.01 });
  evidence("EV-PACK-1", "P-PACK", "bom_composition");
  evidence("EV-SEMI-1", "P-SEMI", "inspection_report", { solid_electrolyte_ratio: 0.6 });

  // ---------- 生产批次与 BOM ----------
  const lot = (id, profileId, qty, completedAt) => append(event({
    type: "PRODUCTION_LOT_RECORDED", aggregateType: "production_lot", aggregateId: id,
    occurredAt: ts(completedAt),
    payload: { lot_id: id, profile_id: profileId, quantity: qty, unit: "个", completed_at: ts(completedAt) },
    summary: `批次完工入库 ${id}`,
  }));
  lot("L-ION-A", "P-ION", 10000, "2026-08-29T16:00:00"); // 跨月在库
  lot("L-ION-B", "P-ION", 4000, "2026-08-25T16:00:00");
  lot("L-ION-C", "P-ION", 4000, "2026-09-09T16:00:00"); // 用于连续生产电池包
  lot("L-SOLID", "P-SOLID", 200, "2026-09-05T16:00:00");
  lot("L-SOLID-B", "P-SOLID", 50, "2026-09-09T16:00:00"); // 内供电池包
  lot("L-HYBRID", "P-HYBRID-MOD", 10, "2026-09-08T16:00:00");
  lot("L-RENAMED", "P-RENAMED", 5000, "2026-09-06T16:00:00");
  lot("L-PACK", "P-PACK", 100, "2026-09-10T16:00:00");

  const consume = (parent, child, qty) => append(event({
    type: "COMPONENT_CONSUMED", aggregateType: "production_lot", aggregateId: parent,
    occurredAt: ts("2026-09-10T15:00:00"),
    payload: { parent_lot_id: parent, component_lot_id: child, quantity: qty },
    summary: `${parent} 领用 ${child}`,
  }));
  consume("L-PACK", "L-ION-C", 4000);
  consume("L-PACK", "L-SOLID-B", 50);

  // ---------- 合同 ----------
  const contract = (id, lines, settlement, at, agreed = []) => append(event({
    type: "CONTRACT_SIGNED", aggregateType: "sales_contract", aggregateId: id,
    occurredAt: at,
    payload: { contract_id: id, lines, settlement, agreed_receipt_dates: agreed, signed_at: at },
    summary: `合同签订 ${id}`,
  }));

  // 跨生效日：8/28 签合同（预收），9/2 才发货
  contract("C-A", [{ lot_id: "L-ION-A", quantity: 10000, unit_price_ex_vat: 10 }],
    { kind: "advance_payment" }, ts("2026-08-28T10:00:00"));
  // 8/31 先开票、9/1 出库
  contract("C-B", [{ lot_id: "L-ION-B", quantity: 4000, unit_price_ex_vat: 12 }],
    { kind: "direct_payment" }, ts("2026-08-30T10:00:00"));
  contract("C-S", [{ lot_id: "L-SOLID", quantity: 200, unit_price_ex_vat: 500 }],
    { kind: "advance_payment" }, ts("2026-09-06T10:00:00"));
  contract("C-H", [{ lot_id: "L-HYBRID", quantity: 10, unit_price_ex_vat: 200000 }],
    { kind: "advance_payment" }, ts("2026-09-09T10:00:00"));
  contract("C-R", [{ lot_id: "L-RENAMED", quantity: 5000, unit_price_ex_vat: 11 }],
    { kind: "advance_payment" }, ts("2026-09-07T10:00:00"));
  contract("C-P", [{ lot_id: "L-PACK", quantity: 100, unit_price_ex_vat: 30000 }],
    { kind: "advance_payment" }, ts("2026-09-12T10:00:00"));

  // ---------- 仓库事件（沿用仓库领域）与发票 ----------
  const move = (kind, lotId, qty, at, ref) => append(event({
    type: kind, aggregateType: "warehouse_inventory", aggregateId: `WH-${lotId}`,
    occurredAt: at,
    payload: { lot_id: lotId, quantity: qty, at, ref },
    summary: `${kind} ${lotId}`,
  }));
  move("STOCK_OUTBOUND", "L-ION-A", 10000, ts("2026-09-02T09:30:00"), "DN-A");
  move("STOCK_OUTBOUND", "L-ION-B", 4000, ts("2026-09-01T09:30:00"), "DN-B");
  move("STOCK_OUTBOUND", "L-SOLID", 200, ts("2026-09-11T09:30:00"), "DN-S");
  move("STOCK_OUTBOUND", "L-HYBRID", 10, ts("2026-09-12T09:30:00"), "DN-H");
  move("STOCK_OUTBOUND", "L-RENAMED", 5000, ts("2026-09-09T09:30:00"), "DN-R");
  move("STOCK_OUTBOUND", "L-PACK", 100, ts("2026-09-13T09:30:00"), "DN-P");

  const invoice = (id, lotId, qty, unit, at, red = false, original = null) => append(event({
    type: red ? "INVOICE_RED_ISSUED" : "INVOICE_ISSUED",
    aggregateType: "invoice", aggregateId: id, occurredAt: at,
    payload: {
      invoice_id: id, original_invoice_id: original,
      lines: [{ lot_id: lotId, quantity: qty, unit_price_ex_vat: unit }],
      amount_ex_vat: qty * unit, issued_at: at,
    },
    summary: red ? `红字发票 ${id}` : `发票 ${id}`,
  }));
  invoice("INV-A", "L-ION-A", 10000, 10, ts("2026-09-02T10:00:00"));
  invoice("INV-B", "L-ION-B", 4000, 12, ts("2026-08-31T15:00:00")); // 先开票
  invoice("INV-S", "L-SOLID", 200, 500, ts("2026-09-11T10:00:00"));
  invoice("INV-R", "L-RENAMED", 5000, 11, ts("2026-09-09T10:00:00"));
  invoice("INV-P", "L-PACK", 100, 30000, ts("2026-09-13T10:00:00"));

  return { store };
}

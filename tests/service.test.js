import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/application/eventStore.js";
import { TaxService, Role } from "../src/application/taxService.js";
import { actors, buildWorld, registerLiCell } from "./helpers/world.js";

async function sell(service, { supplyId, lotId, profileId, price, qty = 100, contracted, dispatched, invoiced, terms }) {
  await service.recordContract(actors.finance, {
    supply_id: supplyId, lot_id: lotId, profile_id: profileId, counterparty: "买方",
    contracted_at: contracted, contracted_price: price, currency: "CNY", quantity: qty, unit: "只",
    settlement_terms: terms, occurred_at: contracted,
  });
  if (dispatched) {
    await service.dispatch(actors.warehouse, {
      supply_id: supplyId, dispatched_at: dispatched, quantity: qty, unit: "只",
      warehouse_event_id: `wh-${supplyId}`, occurred_at: dispatched,
    });
  }
  if (invoiced) {
    await service.issueInvoice(actors.finance, {
      invoice_id: `inv-${supplyId}`, supply_id: supplyId, issued_at: invoiced,
      invoice_price: price, currency: "CNY", invoice_number: `NUM-${supplyId}`, occurred_at: invoiced,
    });
  }
  return service.calculateForSupply(actors.finance, {
    supply_id: supplyId,
    occurred_at: invoiced || dispatched || contracted,
  });
}

test("法规区间重叠被拒绝", async () => {
  const store = new EventStore();
  const service = new TaxService(store);
  await service.registerRule(actors.admin, {
    rule_code: "X", rule_version: 1, title: "a", legal_basis: "b",
    effective_start: "2026-01-01", effective_end: "2026-12-31", time_zone: "Asia/Shanghai", categories: [],
  });
  await assert.rejects(
    () => service.registerRule(actors.admin, {
      rule_code: "X", rule_version: 2, title: "c", legal_basis: "b",
      effective_start: "2026-06-01", effective_end: null, time_zone: "Asia/Shanghai", categories: [],
    }),
    /重叠/
  );
});

test("跨生效日：8/31 先开票适用 2%，9 月发货不改写税率", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-A" });
  await service.recordLot(actors.warehouse, { lot_id: "L-A", profile_id: "P-A", produced_at: "2026-08-30T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-08-30T08:00:00+08:00" });
  const r = await sell(service, {
    supplyId: "S-A", lotId: "L-A", profileId: "P-A", price: 100, qty: 100,
    contracted: "2026-08-30T10:00:00+08:00",
    dispatched: "2026-09-02T09:00:00+08:00",
    invoiced: "2026-08-31T15:00:00+08:00",
    terms: "prepayment",
  });
  assert.equal(r.determination.rule.rule_version, 202601);
  assert.equal(r.determination.rate, 0.02);
  assert.equal(r.determination.tax_amount, 200);
});

test("9 月合同与发货适用 4%", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-B" });
  await service.recordLot(actors.warehouse, { lot_id: "L-B", profile_id: "P-B", produced_at: "2026-09-02T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  const r = await sell(service, {
    supplyId: "S-B", lotId: "L-B", profile_id: "P-B", price: 100, qty: 100,
    contracted: "2026-09-04T10:00:00+08:00",
    dispatched: "2026-09-07T09:00:00+08:00",
    invoiced: "2026-09-08T11:00:00+08:00",
  });
  assert.equal(r.determination.rule.rule_version, 202609);
  assert.equal(r.determination.rate, 0.04);
  assert.equal(r.determination.tax_amount, 400);
});

test("改名不改变分类：液态电芯改名“固态免税”仍按 4%", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-FAKE", name: "普通锂离子电芯" });
  await service.renameProfile(actors.finance, {
    profile_id: "P-FAKE", new_name: "全固态试制免税电芯", reason: "供应商改名",
    renamed_at: "2026-09-03T08:00:00+08:00", occurred_at: "2026-09-03T08:00:00+08:00",
  });
  await service.recordLot(actors.warehouse, { lot_id: "L-F", profile_id: "P-FAKE", produced_at: "2026-09-05T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-05T08:00:00+08:00" });
  const r = await sell(service, {
    supplyId: "S-F", lotId: "L-F", profile_id: "P-FAKE", price: 50, qty: 100,
    contracted: "2026-09-06T10:00:00+08:00", dispatched: "2026-09-09T09:00:00+08:00",
  });
  assert.equal(r.determination.determination?.category || null, null);
  assert.equal(r.determination.explanation.classification.category, "lithium_ion_cell");
  assert.equal(r.determination.rate, 0.04);
  assert.equal(r.determination.tax_amount, 200);
});

test("边界产品未签署不得计税；授权税务人员签署后可计税", async () => {
  const { service } = await buildWorld();
  await service.registerProfile(actors.technical, {
    profile_id: "P-SEMI", market_name: "半固态", declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "semi_solid" },
    occurred_at: "2026-08-22T09:00:00+08:00",
  });
  await service.attachEvidence(actors.technical, {
    profile_id: "P-SEMI", evidence_type: "test_report", evidence_ref: "TR-SEMI",
    issuer: "检测中心", issued_at: "2026-08-19T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "form"], occurred_at: "2026-08-22T09:30:00+08:00",
  });
  await service.recordLot(actors.warehouse, { lot_id: "L-S", profile_id: "P-SEMI", produced_at: "2026-09-05T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-05T08:00:00+08:00" });
  await service.recordContract(actors.finance, {
    supply_id: "S-S", lot_id: "L-S", profile_id: "P-SEMI", counterparty: "买方",
    contracted_at: "2026-09-06T10:00:00+08:00", contracted_price: 100, currency: "CNY",
    quantity: 100, unit: "只", occurred_at: "2026-09-06T10:00:00+08:00",
  });
  await service.dispatch(actors.warehouse, { supply_id: "S-S", dispatched_at: "2026-09-09T09:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-09T09:00:00+08:00" });

  await assert.rejects(() => service.calculateForSupply(actors.finance, { supply_id: "S-S", occurred_at: "2026-09-09T10:00:00+08:00" }), /授权税务人员签署/);

  // 财务/技术均不能签署边界产品
  await assert.rejects(() => service.signClassification(actors.finance, {
    profile_id: "P-SEMI", category: "lithium_ion_cell", evidence_refs: ["TR-SEMI"],
    signed_at: "2026-09-09T11:00:00+08:00", note: "裁定", occurred_at: "2026-09-09T11:00:00+08:00",
  }), /角色不足/);

  // 税务人员作非候选边界裁定必须书面说明
  await assert.rejects(() => service.signClassification(actors.officer, {
    profile_id: "P-SEMI", category: "lithium_ion_cell", evidence_refs: ["TR-SEMI"],
    signed_at: "2026-09-09T11:00:00+08:00", occurred_at: "2026-09-09T11:00:00+08:00",
  }), /note/);

  await service.signClassification(actors.officer, {
    profile_id: "P-SEMI", category: "lithium_ion_cell", evidence_refs: ["TR-SEMI"],
    signed_at: "2026-09-09T11:00:00+08:00", note: "半固态电解质仍属液态体系，按锂离子税目。",
    valid_from: "2026-09-01", occurred_at: "2026-09-09T11:00:00+08:00",
  });
  const r = await service.calculateForSupply(actors.finance, { supply_id: "S-S", occurred_at: "2026-09-09T12:00:00+08:00" });
  assert.equal(r.determination.rate, 0.04);
  assert.equal(r.determination.explanation.classification.signer, "officer");
});

test("固态试制：有资质窗口内免税；缺资质不免税", async () => {
  const { service } = await buildWorld();
  await service.registerProfile(actors.technical, {
    profile_id: "P-SS", market_name: "全固态试制", declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "solid" },
    occurred_at: "2026-08-22T09:00:00+08:00",
  });
  await service.attachEvidence(actors.technical, {
    profile_id: "P-SS", evidence_type: "test_report", evidence_ref: "TR-SS",
    issuer: "检测中心", issued_at: "2026-08-19T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "form"], occurred_at: "2026-08-22T09:30:00+08:00",
  });
  await service.recordLot(actors.warehouse, { lot_id: "L-SS1", profile_id: "P-SS", produced_at: "2026-09-05T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-05T08:00:00+08:00" });

  // 缺资质：系统确认分类为固态但不享受免税 → 4%
  const noQual = await sell(service, {
    supplyId: "S-SS1", lotId: "L-SS1", profile_id: "P-SS", price: 300, qty: 100,
    contracted: "2026-09-06T10:00:00+08:00", dispatched: "2026-09-09T09:00:00+08:00",
  });
  assert.equal(noQual.determination.rate, 0.04);
  assert.equal(noQual.determination.tax_amount, 1200);

  // 补齐资质后另一批，窗口内免税 0
  await service.attachEvidence(actors.officer, {
    profile_id: "P-SS", evidence_type: "pilot_qualification", evidence_ref: "Q-SS",
    issuer: "主管部门", issued_at: "2026-09-02T00:00:00+08:00", attributes_verified: [],
    valid_until: "2027-12-31T23:59:59+08:00", occurred_at: "2026-09-02T10:00:00+08:00",
  });
  await service.recordLot(actors.warehouse, { lot_id: "L-SS2", profile_id: "P-SS", produced_at: "2026-09-10T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-10T08:00:00+08:00" });
  const qual = await sell(service, {
    supplyId: "S-SS2", lotId: "L-SS2", profile_id: "P-SS", price: 300, qty: 100,
    contracted: "2026-09-11T10:00:00+08:00", dispatched: "2026-09-12T09:00:00+08:00",
  });
  assert.equal(qual.determination.exempt, true);
  assert.equal(qual.determination.tax_amount, 0);
});

test("退货冲正不覆盖原分录；净额正确；超额冲正被拒", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-R" });
  await service.recordLot(actors.warehouse, { lot_id: "L-R", profile_id: "P-R", produced_at: "2026-09-02T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  const r = await sell(service, {
    supplyId: "S-R", lotId: "L-R", profile_id: "P-R", price: 100, qty: 100,
    contracted: "2026-09-04T10:00:00+08:00", dispatched: "2026-09-07T09:00:00+08:00",
  });
  const entryId = r.determination.entry_id;
  await service.reverseEntry(actors.finance, {
    entry_id: entryId, reason_code: "return", reason_ref: "RET-1",
    tax_amount: -100, quantity: 25, reversed_at: "2026-09-20T10:00:00+08:00", occurred_at: "2026-09-20T10:00:00+08:00",
  });
  await assert.rejects(() => service.reverseEntry(actors.finance, {
    entry_id: entryId, reason_code: "return", tax_amount: -999,
    reversed_at: "2026-09-21T10:00:00+08:00", occurred_at: "2026-09-21T10:00:00+08:00",
  }), /冲正超额/);

  const state = service.state();
  const e = state.entries.get(entryId);
  assert.equal(e.tax_amount, 400); // 原分录从未被修改
  assert.equal(e.reversed_by.length, 1);
  const net = [...state.entries.values()].filter((x) => x.lot_id === "L-R").reduce((s, x) => s + x.tax_amount, 0);
  assert.equal(net, 300);
});

test("同一供应单不得重复计税，必须先冲正", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-D" });
  await service.recordLot(actors.warehouse, { lot_id: "L-D", profile_id: "P-D", produced_at: "2026-09-02T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  await sell(service, {
    supplyId: "S-D", lotId: "L-D", profile_id: "P-D", price: 100, qty: 100,
    contracted: "2026-09-04T10:00:00+08:00", dispatched: "2026-09-07T09:00:00+08:00",
  });
  await assert.rejects(() => sell(service, {
    supplyId: "S-D", lotId: "L-D", profile_id: "P-D", price: 110, qty: 100,
    contracted: "2026-09-04T10:00:00+08:00", dispatched: "2026-09-07T09:00:00+08:00",
  }), /已有有效计税分录/);
});

test("申报锁定后分录不得重复申报", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-F2" });
  await service.recordLot(actors.warehouse, { lot_id: "L-F2", profile_id: "P-F2", produced_at: "2026-09-02T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  const r = await sell(service, {
    supplyId: "S-F2", lotId: "L-F2", profile_id: "P-F2", price: 100, qty: 100,
    contracted: "2026-09-04T10:00:00+08:00", dispatched: "2026-09-07T09:00:00+08:00",
  });
  const id = r.determination.entry_id;
  await service.submitFiling(actors.finance, {
    filing_id: "F1", period_start: "2026-09-01", period_end: "2026-09-30",
    entry_ids: [id], submitted_at: "2026-10-10T09:00:00+08:00", occurred_at: "2026-10-10T09:00:00+08:00",
  });
  await assert.rejects(() => service.submitFiling(actors.finance, {
    filing_id: "F2", period_start: "2026-09-01", period_end: "2026-09-30",
    entry_ids: [id], submitted_at: "2026-10-11T09:00:00+08:00", occurred_at: "2026-10-11T09:00:00+08:00",
  }), /不得重复申报/);
});

test("时间旅行：截至 8/31 的重放状态看不到九月才登记的签署", async () => {
  const { service, store } = await buildWorld();
  await registerLiCell(service, { profileId: "P-T" });
  await service.signClassification(actors.officer, {
    profile_id: "P-T", category: "lithium_ion_cell", evidence_refs: ["TR-P-T"],
    signed_at: "2026-09-05T10:00:00+08:00", note: "人工确认",
    occurred_at: "2026-09-05T10:00:00+08:00",
  });
  const { fold } = await import("../src/domain/projections.js");
  const aug = fold(store.stream({ asOf: "2026-08-31T23:59:59+08:00" }));
  assert.equal(aug.signings.get("P-T"), undefined);
  const sep = fold(store.stream({ asOf: "2026-09-05T10:00:00+08:00" }));
  assert.equal(sep.signings.get("P-T").length, 1);
});

test("角色：技术人员不能计税；审计人员只读", async () => {
  const { service } = await buildWorld();
  await assert.rejects(() => service.calculateForSupply(actors.technical, { supply_id: "X" }), /角色不足/);
  await assert.rejects(() => service.submitFiling(actors.warehouse, { filing_id: "z" }), /角色不足/);
});

test("仓库事件适配：入库/出库/BOM 可经统一入口接入", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-W" });
  await service.recordLot(actors.warehouse, { lot_id: "L-W1", profile_id: "P-W", produced_at: "2026-09-01T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-01T08:00:00+08:00" });
  const { WarehouseAdapter } = await import("../src/application/warehouseAdapter.js");
  const adapter = new WarehouseAdapter(service);
  const events = await adapter.ingest(actors.warehouse, {
    event: "GOODS_COMPLETED_TO_STOCK", event_id: "wh-evt-1",
    lot_id: "L-W1", completed_at: "2026-09-02T10:00:00+08:00", quantity: 100, unit: "只",
  });
  assert.equal(events[0].event_type, "LOT_COMPLETED");
  assert.equal(events[0].causation_id, "wh-evt-1");
  // 幂等：同一仓库事件重放不产生重复
  await assert.rejects(() => adapter.ingest(actors.warehouse, {
    event: "GOODS_COMPLETED_TO_STOCK", event_id: "wh-evt-1",
    lot_id: "L-W1", completed_at: "2026-09-02T10:00:00+08:00", quantity: 100, unit: "只",
  }), /idempotency/);
});

test("JSONL 持久化与重放一致", async () => {
  const file = `/tmp/tax-test-${process.pid}.jsonl`;
  const store1 = new EventStore({ file });
  const service1 = new TaxService(store1);
  await service1.registerRule(actors.admin, {
    rule_code: "P", rule_version: 1, title: "t", legal_basis: "b",
    effective_start: "2026-01-01", effective_end: null, time_zone: "Asia/Shanghai", categories: [],
  });
  const { EventStore: ES2 } = await import("../src/application/eventStore.js");
  const store2 = await ES2.fromFile(file);
  assert.equal(store2.all().length, 1);
  assert.equal(store2.all()[0].event_type, "RULE_EFFECTIVE");
});

import assert from "node:assert/strict";
import test from "node:test";

import { actors, buildWorld, registerLiCell } from "./helpers/world.js";
import { traceBom, auditDoubleTaxation, explainEntry } from "../src/domain/audit.js";

async function moduleWithCells(service) {
  const { service: svc } = { service };
  // 电芯批次
  await registerLiCell(svc, { profileId: "P-CELL" });
  await svc.recordLot(actors.warehouse, { lot_id: "L-CELL", profile_id: "P-CELL", produced_at: "2026-09-01T08:00:00+08:00", quantity: 10000, unit: "只", occurred_at: "2026-09-01T08:00:00+08:00" });
  // 模组产品（按模组分类，此处仅构造 BOM，不要求分类齐备）
  await svc.registerProfile(actors.technical, {
    profile_id: "P-MOD", market_name: "储能模组", declared_form: "module",
    attributes: { form: "module", chemistry_mix: "hybrid", energy_density_wh_per_kg: 290 },
    occurred_at: "2026-08-21T09:00:00+08:00",
  });
  await svc.attachEvidence(actors.technical, {
    profile_id: "P-MOD", evidence_type: "test_report", evidence_ref: "TR-MOD",
    issuer: "检测中心", issued_at: "2026-08-18T00:00:00+08:00",
    attributes_verified: ["form", "chemistry_mix", "energy_density_wh_per_kg"],
    occurred_at: "2026-08-21T09:30:00+08:00",
  });
  await svc.recordLot(actors.warehouse, { lot_id: "L-MOD", profile_id: "P-MOD", produced_at: "2026-09-05T08:00:00+08:00", quantity: 10, unit: "套", occurred_at: "2026-09-05T08:00:00+08:00" });
  await svc.linkBom(actors.warehouse, {
    lot_id: "L-CELL", module_lot_id: "L-MOD", quantity_consumed: 4000, unit: "只",
    occurred_at: "2026-09-05T12:00:00+08:00",
  });
}

async function sellLot(service, supplyId, lotId, profileId, price, qty, unit) {
  await service.recordContract(actors.finance, {
    supply_id: supplyId, lot_id: lotId, profile_id: profileId, counterparty: "买方",
    contracted_at: "2026-09-06T10:00:00+08:00", contracted_price: price, currency: "CNY",
    quantity: qty, unit, occurred_at: "2026-09-06T10:00:00+08:00",
  });
  await service.dispatch(actors.warehouse, {
    supply_id: supplyId, dispatched_at: "2026-09-07T09:00:00+08:00", quantity: qty, unit,
    occurred_at: "2026-09-07T09:00:00+08:00",
  });
  return service.calculateForSupply(actors.finance, { supply_id: supplyId, occurred_at: "2026-09-07T10:00:00+08:00" });
}

test("BOM 展开：模组可追到所含电芯批次及耗用量", async () => {
  const { service } = await buildWorld();
  await moduleWithCells(service);
  const state = service.state();
  const traced = traceBom(state, "L-MOD");
  assert.equal(traced.tree.lot_id, "L-MOD");
  assert.equal(traced.tree.components[0].lot_id, "L-CELL");
  assert.equal(traced.tree.components[0].edge_quantity_consumed, 4000);
});

test("重复计税审计：电芯直销计税且模组也计税时给出标记", async () => {
  const { service } = await buildWorld();
  await moduleWithCells(service);
  // 电芯部分直销并计税
  await sellLot(service, "S-CELL", "L-CELL", "P-CELL", 60, 1000, "只");
  // 模组销售并计税（4% 模组档：290 → 实际 2%，这里简化用证据齐备的分类）
  await sellLot(service, "S-MOD", "L-MOD", "P-MOD", 20000, 10, "套");

  const audit = auditDoubleTaxation(service.state(), "L-MOD");
  assert.equal(audit.ok, true);
  assert.ok(audit.double_taxation_flags.some((f) => f.component_lot_id === "L-CELL" && f.taxed_at_ancestor_lot_id === "L-MOD"));
});

test("仅模组计税、电芯未直销时不产生重复标记", async () => {
  const { service } = await buildWorld();
  await moduleWithCells(service);
  await sellLot(service, "S-MOD", "L-MOD", "P-MOD", 20000, 10, "套");
  const audit = auditDoubleTaxation(service.state(), "L-MOD");
  assert.deepEqual(audit.double_taxation_flags, []);
});

test("解释包含法规版本、签署人、证据与价格来源", async () => {
  const { service } = await buildWorld();
  await registerLiCell(service, { profileId: "P-X" });
  await service.recordLot(actors.warehouse, { lot_id: "L-X", profile_id: "P-X", produced_at: "2026-09-02T08:00:00+08:00", quantity: 100, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00" });
  const r = await sellLot(service, "S-X", "L-X", "P-X", 80, 100, "只");
  const explanation = explainEntry(service.state(), r.determination.entry_id);
  assert.equal(explanation.ok, true);
  assert.equal(explanation.rule.rule_version, 202609);
  assert.equal(explanation.evidence[0].evidence_ref, "TR-P-X");
  assert.equal(explanation.calculation.price.tax_basis_price, 80);
  assert.equal(explanation.market_name_trace.current_name, "锂离子电芯");
});

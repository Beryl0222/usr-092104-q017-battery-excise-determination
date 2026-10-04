import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/application/eventStore.js";
import { TaxService } from "../src/application/taxService.js";
import { QueryService } from "../src/application/queryService.js";
import { createApp } from "../src/http/app.js";

async function start() {
  const store = new EventStore();
  const service = new TaxService(store);
  const query = new QueryService(store);
  const app = createApp(service, query);
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  return { app, port, service, store };
}

async function call(port, { method = "GET", path, body, roles, user = "u1" }) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": user,
      ...(roles ? { "x-user-roles": roles.join(",") } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP：健康检查", async () => {
  const { app, port } = await start();
  const r = await call(port, { path: "/api/health" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
  await new Promise((res) => app.close(res));
});

test("HTTP：完整一笔——注册规则、产品、证据、批次、合同、发货、计税、解释", async () => {
  const { app, port } = await start();
  const admin = ["rule_admin"];
  const tech = ["technical"];
  const wh = ["warehouse"];
  const fin = ["finance"];

  let r = await call(port, { method: "POST", path: "/api/rules", roles: admin, body: {
    rule_code: "LI", rule_version: 1, title: "九月", legal_basis: "b",
    effective_start: "2026-09-01", effective_end: null, time_zone: "Asia/Shanghai",
    rounding: { decimals: 2, mode: "half_up" },
    categories: [{
      category: "c", rate: 0.04,
      criteria: { requires: [{ attribute: "form", op: "eq", value: "cell" }], required_attributes: ["form"], required_evidence_types: ["test_report"] },
    }],
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/profiles", roles: tech, body: {
    profile_id: "P1", market_name: "市场名随意", declared_form: "cell",
    attributes: { form: "cell" }, occurred_at: "2026-09-01T09:00:00+08:00",
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/evidence", roles: tech, body: {
    profile_id: "P1", evidence_type: "test_report", evidence_ref: "TR1", issuer: "中心",
    issued_at: "2026-08-30T00:00:00+08:00", attributes_verified: ["form"],
    occurred_at: "2026-09-01T09:30:00+08:00",
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/lots", roles: wh, body: {
    lot_id: "L1", profile_id: "P1", produced_at: "2026-09-02T08:00:00+08:00",
    quantity: 10, unit: "只", occurred_at: "2026-09-02T08:00:00+08:00",
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/supplies", roles: fin, body: {
    supply_id: "S1", lot_id: "L1", profile_id: "P1", counterparty: "买方",
    contracted_at: "2026-09-03T10:00:00+08:00", contracted_price: 100, currency: "CNY",
    quantity: 10, unit: "只", occurred_at: "2026-09-03T10:00:00+08:00",
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/dispatches", roles: wh, body: {
    supply_id: "S1", dispatched_at: "2026-09-05T09:00:00+08:00", quantity: 10, unit: "只",
    occurred_at: "2026-09-05T09:00:00+08:00",
  }});
  assert.equal(r.status, 200);

  r = await call(port, { method: "POST", path: "/api/calculate", roles: fin, body: {
    supply_id: "S1", occurred_at: "2026-09-05T10:00:00+08:00",
  }});
  assert.equal(r.status, 200);
  const entryId = r.json.events.find((e) => e.event_type === "TAX_CALCULATED").payload.entry_id;
  assert.equal(r.json.events.find((e) => e.event_type === "TAX_CALCULATED").payload.tax_amount, 40);

  r = await call(port, { path: `/api/entries/${entryId}/explain` });
  assert.equal(r.status, 200);
  assert.equal(r.json.calculation.computation.tax_amount, 40);

  // 无角色：被拒
  r = await call(port, { method: "POST", path: "/api/rules", roles: [], body: {} });
  assert.equal(r.status, 403);

  await new Promise((res) => app.close(res));
});

test("HTTP：仓库事件统一入口", async () => {
  const { app, port, service } = await start();
  // 先准备规则/产品/批次
  await call(port, { method: "POST", path: "/api/rules", roles: ["rule_admin"], body: {
    rule_code: "LI", rule_version: 1, title: "t", legal_basis: "b",
    effective_start: "2026-09-01", effective_end: null, time_zone: "Asia/Shanghai", categories: [],
  }});
  await call(port, { method: "POST", path: "/api/profiles", roles: ["technical"], body: {
    profile_id: "P1", market_name: "n", declared_form: "cell",
    attributes: { form: "cell" }, occurred_at: "2026-09-01T09:00:00+08:00",
  }});
  await call(port, { method: "POST", path: "/api/lots", roles: ["warehouse"], body: {
    lot_id: "L1", profile_id: "P1", produced_at: "2026-09-01T08:00:00+08:00",
    quantity: 1, unit: "只", occurred_at: "2026-09-01T08:00:00+08:00",
  }});
  const r = await call(port, { method: "POST", path: "/api/warehouse/events", roles: ["warehouse"], body: {
    event: "GOODS_COMPLETED_TO_STOCK", event_id: "wh-1",
    lot_id: "L1", completed_at: "2026-09-02T10:00:00+08:00", quantity: 1, unit: "只",
  }});
  assert.equal(r.status, 200);
  assert.equal(r.json.events[0].event_type, "LOT_COMPLETED");
  assert.equal(service.state().lots.get("L1").completed_at, "2026-09-02T10:00:00+08:00");
  await new Promise((res) => app.close(res));
});

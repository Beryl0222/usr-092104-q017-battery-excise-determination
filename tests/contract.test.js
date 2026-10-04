import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, EVENT_TYPES, EventType } from "../src/domain/events.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("历史五事件仍登记在目录中（向后兼容）", () => {
  for (const t of ["RULE_EFFECTIVE", "LOT_CLASSIFIED", "TAX_CALCULATED", "FILING_SUBMITTED", "ENTRY_ADJUSTED"]) {
    assert.ok(EVENT_TYPES.includes(t), `${t} 应保留`);
  }
});

test("LOT_CLASSIFIED 等历史事件以兼容模式接受", () => {
  const errors = validateEvent({
    event_id: "legacy-1",
    event_type: "LOT_CLASSIFIED",
    aggregate_type: "battery_classification",
    aggregate_id: "c1",
    occurred_at: "2026-09-01T00:00:00+08:00",
    version: 1,
    summary: "历史事件",
  });
  assert.deepEqual(errors, []);
});

test("payload 必填字段缺失被检出", () => {
  const errors = validateEvent({
    event_id: "e1",
    event_type: EventType.TAX_CALCULATED,
    aggregate_type: "tax_entry",
    aggregate_id: "x",
    occurred_at: "2026-09-01T00:00:00+08:00",
    version: 1,
    summary: "s",
    payload: { lot_id: "L1" },
  });
  assert.ok(errors.some((e) => e.includes("entry_id")));
  assert.ok(errors.some((e) => e.includes("tax_amount")));
});

test("事件类型与聚合类型不匹配被检出", () => {
  const errors = validateEvent({
    event_id: "e2",
    event_type: EventType.RULE_EFFECTIVE,
    aggregate_type: "tax_entry",
    aggregate_id: "x",
    occurred_at: "2026-09-01T00:00:00+08:00",
    version: 1,
    summary: "s",
  });
  assert.ok(errors.some((e) => e.includes("聚合应为 tax_rule")));
});

test("occurred_at 缺少时区偏移被拒绝", () => {
  const errors = validateEvent({
    event_id: "e3",
    event_type: EventType.RULE_EFFECTIVE,
    aggregate_type: "tax_rule",
    aggregate_id: "x",
    occurred_at: "2026-09-01T00:00:00",
    version: 1,
    summary: "s",
  });
  assert.ok(errors.some((e) => e.includes("带偏移")));
});

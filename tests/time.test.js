import assert from "node:assert/strict";
import test from "node:test";

import {
  localDayStartUtc,
  localDayEndUtcExclusive,
  localDayOf,
  ruleEffectiveAt,
  intervalsOverlap,
} from "../src/domain/time.js";

const CN = "Asia/Shanghai";

test("北京日历日 00:00 = UTC 前一日 16:00", () => {
  assert.equal(localDayStartUtc("2026-09-01", CN).toISOString(), "2026-08-31T16:00:00.000Z");
});

test("半开区间右端为结束日次日 00:00（北京）", () => {
  assert.equal(localDayEndUtcExclusive("2026-08-31", CN).toISOString(), "2026-08-31T16:00:00.000Z");
});

test("生效边界含起始瞬间、不含结束次日瞬间", () => {
  const v1 = { effective_start: "2026-01-01", effective_end: "2026-08-31", time_zone: CN };
  assert.equal(ruleEffectiveAt(v1, "2026-08-31T15:59:59+08:00"), true);
  assert.equal(ruleEffectiveAt(v1, "2026-08-31T16:00:00Z"), false); // 北京 9/1 00:00
  const v2 = { effective_start: "2026-09-01", effective_end: null, time_zone: CN };
  assert.equal(ruleEffectiveAt(v2, "2026-08-31T15:59:59Z"), false); // 北京 8/31 23:59
  assert.equal(ruleEffectiveAt(v2, "2026-08-31T16:00:00Z"), true);
});

test("当地日历日换算", () => {
  assert.equal(localDayOf("2026-08-31T15:59:59Z", CN), "2026-08-31");
  assert.equal(localDayOf("2026-08-31T16:00:00Z", CN), "2026-09-01");
});

test("夏令时时区边界仍取当地午夜（纽约）", () => {
  // 2026-03-08 美国进入夏令时（UTC-5），当天当地午夜 = 05:00Z
  assert.equal(localDayStartUtc("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(localDayOf("2026-03-08T05:00:00Z", "America/New_York"), "2026-03-08");
});

test("非法时区与日历日被拒绝", () => {
  assert.throws(() => localDayStartUtc("2026-09-01", "Mars/Olympus"));
  assert.throws(() => localDayStartUtc("2026-9-1", CN));
});

test("区间重叠检测", () => {
  const a = { effective_start: "2026-01-01", effective_end: "2026-08-31" };
  const b = { effective_start: "2026-09-01", effective_end: null };
  const c = { effective_start: "2026-08-15", effective_end: "2026-09-15" };
  assert.equal(intervalsOverlap(a, b), false);
  assert.equal(intervalsOverlap(a, c), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { classify, evidenceValidAt } from "../src/domain/classification.js";

const rule = {
  categories: [
    {
      category: "lithium_ion_cell",
      rate: 0.04,
      criteria: {
        requires: [
          { attribute: "electrolyte_state", op: "eq", value: "liquid" },
          { attribute: "form", op: "eq", value: "cell" },
        ],
        required_attributes: ["electrolyte_state"],
        required_evidence_types: ["test_report"],
      },
    },
    {
      category: "solid_state_cell",
      rate: 0.04,
      criteria: {
        requires: [
          { attribute: "electrolyte_state", op: "eq", value: "solid" },
          { attribute: "form", op: "eq", value: "cell" },
        ],
        required_attributes: ["electrolyte_state"],
        required_evidence_types: ["test_report"],
      },
    },
  ],
};

const liProfile = {
  profile_id: "P1",
  market_name: "随便叫什么都不影响",
  attributes: { form: "cell", electrolyte_state: "liquid" },
};

test("属性满足且证据齐备：唯一 verified 候选，非边界", () => {
  const r = classify({
    profile: liProfile,
    evidence: [
      { evidence_type: "test_report", issued_at: "2026-08-01T00:00:00+08:00", attributes_verified: ["electrolyte_state"] },
    ],
    rule,
    asOf: "2026-09-01T00:00:00+08:00",
  });
  assert.deepEqual(r.candidates.map((c) => c.category), ["lithium_ion_cell"]);
  assert.equal(r.candidates[0].confidence, "verified");
  assert.equal(r.boundary, false);
  assert.deepEqual(r.missing_evidence, []);
});

test("缺少检验报告：候选仍在但证据不完整、标记边界", () => {
  const r = classify({ profile: liProfile, evidence: [], rule, asOf: "2026-09-01T00:00:00+08:00" });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].confidence, "incomplete_evidence");
  assert.equal(r.boundary, true);
  assert.ok(r.missing_evidence.join("").includes("test_report"));
});

test("属性缺失的税目无法排除时标记边界并列出缺失", () => {
  const r = classify({
    profile: { profile_id: "P2", market_name: "半固态", attributes: { form: "cell" } },
    evidence: [],
    rule,
    asOf: "2026-09-01T00:00:00+08:00",
  });
  assert.equal(r.boundary, true);
  assert.ok(r.missing_evidence.join("").includes("electrolyte_state"));
});

test("多候选：边界产品", () => {
  const bothRule = {
    categories: [
      ...rule.categories,
      {
        category: "weird",
        rate: 0.04,
        criteria: { requires: [{ attribute: "form", op: "eq", value: "cell" }], required_attributes: [], required_evidence_types: [] },
      },
    ],
  };
  const r = classify({
    profile: liProfile,
    evidence: [
      { evidence_type: "test_report", issued_at: "2026-08-01T00:00:00+08:00", attributes_verified: ["electrolyte_state"] },
    ],
    rule: bothRule,
    asOf: "2026-09-01T00:00:00+08:00",
  });
  assert.ok(r.candidates.length >= 2);
  assert.equal(r.boundary, true);
});

test("证据有效期：未签发/已过期均不可用", () => {
  assert.equal(evidenceValidAt({ issued_at: "2026-09-02T00:00:00+08:00" }, "2026-09-01T00:00:00+08:00"), false);
  assert.equal(
    evidenceValidAt(
      { issued_at: "2026-08-01T00:00:00+08:00", valid_until: "2026-09-01T00:00:00+08:00" },
      "2026-09-01T00:00:00+08:00"
    ),
    false
  );
  assert.equal(
    evidenceValidAt({ issued_at: "2026-08-01T00:00:00+08:00", valid_until: "2026-09-02T00:00:00+08:00" }, "2026-09-01T00:00:00+08:00"),
    true
  );
});

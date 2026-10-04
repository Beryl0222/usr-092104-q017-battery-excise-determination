// 测试用世界构造：与 scripts/seed 相同的规则与角色，但粒度更小，供各测试复用。
import { EventStore } from "../src/application/eventStore.js";
import { TaxService, Role } from "../src/application/taxService.js";
import { QueryService } from "../src/application/queryService.js";

export const actors = {
  admin: { id: "admin", roles: [Role.RULE_ADMIN] },
  officer: { id: "officer", roles: [Role.TAX_OFFICER] },
  finance: { id: "finance", roles: [Role.FINANCE] },
  technical: { id: "technical", roles: [Role.TECHNICAL] },
  warehouse: { id: "wh", roles: [Role.WAREHOUSE] },
};

export const rules = {
  v1: {
    rule_code: "LI_EXCISE",
    rule_version: 202601,
    title: "一月版",
    legal_basis: "b1",
    effective_start: "2026-01-01",
    effective_end: "2026-08-31",
    time_zone: "Asia/Shanghai",
    categories: [
      {
        category: "lithium_ion_cell",
        title: "锂离子电芯",
        rate: 0.02,
        criteria: {
          requires: [
            { attribute: "electrolyte_state", op: "eq", value: "liquid" },
            { attribute: "form", op: "eq", value: "cell" },
          ],
          required_attributes: ["electrolyte_state"],
          required_evidence_types: ["test_report"],
        },
      },
    ],
  },
  v2: {
    rule_code: "LI_EXCISE",
    rule_version: 202609,
    title: "九月版",
    legal_basis: "b2",
    effective_start: "2026-09-01",
    effective_end: null,
    time_zone: "Asia/Shanghai",
    rounding: { decimals: 2, mode: "half_up" },
    categories: [
      {
        category: "lithium_ion_cell",
        title: "锂离子电芯",
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
        title: "固态试制电芯",
        rate: 0.04,
        exemption_windows: [
          { start: "2026-09-01", end: "2027-12-31", phase: "pilot", requires_evidence_types: ["pilot_qualification"] },
        ],
        criteria: {
          requires: [
            { attribute: "electrolyte_state", op: "eq", value: "solid" },
            { attribute: "form", op: "eq", value: "cell" },
          ],
          required_attributes: ["electrolyte_state"],
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
        criteria: {
          requires: [
            { attribute: "form", op: "eq", value: "module" },
            { attribute: "chemistry_mix", op: "eq", value: "hybrid" },
          ],
          required_attributes: ["energy_density_wh_per_kg"],
          required_evidence_types: ["test_report"],
        },
      },
    ],
  },
};

export async function buildWorld() {
  const store = new EventStore();
  const service = new TaxService(store);
  const query = new QueryService(store);
  await service.registerRule(actors.admin, { ...rules.v1, occurred_at: "2025-12-25T10:00:00+08:00" });
  await service.registerRule(actors.admin, { ...rules.v2, occurred_at: "2026-08-20T09:00:00+08:00" });
  return { store, service, query };
}

export async function registerLiCell(service, { profileId = "P-LI", name = "锂离子电芯", density } = {}) {
  await service.registerProfile(actors.technical, {
    profile_id: profileId,
    market_name: name,
    declared_form: "cell",
    attributes: { form: "cell", electrolyte_state: "liquid", ...(density ? { energy_density_wh_per_kg: density } : {}) },
    occurred_at: "2026-08-21T09:00:00+08:00",
  });
  await service.attachEvidence(actors.technical, {
    profile_id: profileId,
    evidence_type: "test_report",
    evidence_ref: `TR-${profileId}`,
    issuer: "检测中心",
    issued_at: "2026-08-18T00:00:00+08:00",
    attributes_verified: ["electrolyte_state", "form"],
    occurred_at: "2026-08-21T09:30:00+08:00",
  });
}

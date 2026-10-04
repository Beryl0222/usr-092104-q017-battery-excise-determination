// 技术档案、证据与分类结论投影。
// 判定链条：技术属性 -> 候选分类；证据齐备且属性与检验实测一致 -> 可自动确认的非边界分类；
// 边界产品 -> 只给候选与缺失证据，必须由授权人员签署 CLASSIFICATION_SIGNED。
// 市场名称改名不影响任何结论：profile_id 是稳定身份，名称不作为输入。

import { fold } from "./store.js";
import {
  CATEGORIES,
  MEASUREMENT_TOLERANCE,
  candidateCategories,
} from "./catalog.js";

export function projectClassifications(events) {
  return fold(
    events,
    () => ({ profiles: new Map(), evidence: new Map(), decisions: new Map() }),
    {
      TECHNICAL_PROFILE_REGISTERED: (s, e) => {
        const p = e.payload;
        s.profiles.set(p.profile_id, {
          profile_id: p.profile_id,
          production_lot_ids: p.production_lot_ids ?? [],
          attrs: p.attributes ?? {},
          market_names: p.market_names ?? [], // 仅留档用于审计识别“改名”，不进入判定
          registered_at_ms: Date.parse(e.occurred_at),
        });
      },
      EVIDENCE_SUBMITTED: (s, e) => {
        const p = e.payload;
        s.evidence.set(e.aggregate_id, {
          evidence_id: e.aggregate_id,
          profile_id: p.profile_id,
          evidence_type: p.evidence_type,
          document_ref: p.document_ref,
          measured: p.measured ?? null,
          issuer: p.issuer ?? null,
          submitted_at_ms: Date.parse(e.occurred_at),
        });
      },
      CLASSIFICATION_SIGNED: (s, e) => {
        const p = e.payload;
        const prev = s.decisions.get(p.profile_id);
        s.decisions.set(p.profile_id, {
          profile_id: p.profile_id,
          decided_category: p.decided_category,
          signer_id: p.signer_id,
          signer_role: p.signer_role,
          evidence_ids: p.evidence_ids,
          signed_at_ms: Date.parse(p.signed_at),
          supersedes: prev ? prev.signed_at_ms : null,
          reason: p.reason ?? null,
        });
      },
    },
  );
}

function evidenceForProfile(state, profileId) {
  return [...state.evidence.values()].filter((x) => x.profile_id === profileId);
}

// 评估某档案在给定时间点前的分类状态：候选、缺失证据、属性矛盾、最终结论。
export function evaluateProfile(state, profileId, { asOfMs = Infinity } = {}) {
  const profile = state.profiles.get(profileId);
  if (!profile) throw new Error(`技术档案不存在：${profileId}`);

  const candidates = candidateCategories(profile.attrs);
  const evidences = evidenceForProfile(state, profileId).filter((x) => x.submitted_at_ms < asOfMs);
  const haveTypes = new Set(evidences.map((x) => x.evidence_type));

  // 检验报告实测值与档案属性矛盾（供应商改名/虚假填报的主要拦截点）。
  const contradictions = [];
  for (const ev of evidences) {
    const m = ev.measured ?? {};
    if (typeof m.solid_electrolyte_ratio === "number") {
      const declared = Number(profile.attrs.solid_electrolyte_ratio ?? 0);
      if (Math.abs(m.solid_electrolyte_ratio - declared) > MEASUREMENT_TOLERANCE) {
        contradictions.push({
          evidence_id: ev.evidence_id,
          field: "solid_electrolyte_ratio",
          declared,
          measured: m.solid_electrolyte_ratio,
        });
      }
    }
    if (typeof m.contains_solid_state_trial === "boolean" &&
        m.contains_solid_state_trial !== profile.attrs.contains_solid_state_trial) {
      contradictions.push({
        evidence_id: ev.evidence_id,
        field: "contains_solid_state_trial",
        declared: profile.attrs.contains_solid_state_trial,
        measured: m.contains_solid_state_trial,
      });
    }
  }

  const resultFor = (category) => {
    const def = CATEGORIES[category];
    const missing = def.required_evidence.filter((t) => !haveTypes.has(t));
    return {
      category,
      boundary: def.boundary,
      missing_evidence: missing,
      ready: missing.length === 0 && contradictions.length === 0,
    };
  };
  const evaluations = candidates.map(resultFor);

  const signed = [...state.decisions.values()]
    .filter((d) => d.profile_id === profileId && d.signed_at_ms < asOfMs)
    .sort((a, b) => b.signed_at_ms - a.signed_at_ms)[0];

  // 非边界且证据齐备的唯一候选可自动确认；其余必须签署。
  let decided = null;
  let decision_basis = null;
  if (signed) {
    decided = signed.decided_category;
    decision_basis = { kind: "signed", signer_id: signed.signer_id, signer_role: signed.signer_role,
      evidence_ids: signed.evidence_ids, signed_at_ms: signed.signed_at_ms };
  } else if (evaluations.length === 1 && evaluations[0].ready && !evaluations[0].boundary) {
    decided = evaluations[0].category;
    decision_basis = { kind: "automatic", evidence: [...haveTypes] };
  }

  return {
    profile_id: profileId,
    candidates: evaluations,
    contradictions,
    requires_signature: decided === null,
    decided_category: decided,
    decision_basis,
  };
}

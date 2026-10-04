// 只读查询 API：解释、重放、候选分类、审计追踪、申报。
import { fold, effectiveSigning } from "../domain/projections.js";
import { classify } from "../domain/classification.js";
import { resolveRule, resolveRate } from "../domain/taxation.js";
import { explainEntry, auditDoubleTaxation, traceBom } from "../domain/audit.js";
import { entryChain, validateFiling } from "../domain/ledger.js";

export class QueryService {
  constructor(store) {
    this.store = store;
  }

  state(asOf) {
    return fold(this.store.stream(asOf ? { asOf } : undefined));
  }

  // 列出候选分类与缺失证据（只读，不产生签署）。
  proposal({ profile_id, as_of, rule_code }) {
    const state = this.state(as_of);
    const profile = state.profiles.get(profile_id);
    if (!profile) return { ok: false, status: 404, error: `产品档案不存在：${profile_id}` };
    const resolved = resolveRule(state.rules, rule_code || "LI_EXCISE", as_of || new Date().toISOString());
    if (!resolved.ok) return { ok: false, status: 422, error: resolved.error };
    const evidence = state.evidence.get(profile_id) || [];
    const result = classify({ profile, evidence, rule: resolved.rule, asOf: as_of || new Date().toISOString() });
    const signing = effectiveSigning(state, profile_id, as_of || new Date().toISOString());
    return {
      ok: true,
      profile_id,
      market_name: profile.market_name,
      name_history: profile.name_history,
      attributes: profile.attributes,
      rule: { rule_code: resolved.rule.rule_code, rule_version: resolved.rule.rule_version, effective_start: resolved.rule.effective_start, effective_end: resolved.rule.effective_end },
      candidates: result.candidates,
      missing_evidence: result.missing_evidence,
      boundary: result.boundary,
      active_signed_classification: signing
        ? { category: signing.category, signer: signing.signer, signer_role: signing.signer_role, signed_at: signing.signed_at, boundary: signing.boundary, evidence_refs: signing.evidence_refs }
        : null,
      market_name_note: "市场名称仅用于展示与改名留痕，不参与税率判定。",
    };
  }

  // 按某时刻重放：返回当时有效法规、税率与签署，演示 2%→4% 与免税到期。
  replay({ profile_id, category, at, rule_code }) {
    const state = this.state(at);
    const profile = state.profiles.get(profile_id);
    if (!profile) return { ok: false, status: 404, error: `产品档案不存在：${profile_id}` };
    const resolved = resolveRule(state.rules, rule_code || "LI_EXCISE", at);
    if (!resolved.ok) return { ok: false, status: 422, error: resolved.error, replayed_at: at };
    const rate = resolveRate(resolved.rule, category, profile.attributes, at, state.evidence.get(profile_id) || []);
    if (!rate.ok) return { ok: false, status: 422, error: rate.error };
    return {
      ok: true,
      replayed_at: at,
      rule: {
        rule_code: resolved.rule.rule_code,
        rule_version: resolved.rule.rule_version,
        title: resolved.rule.title,
        legal_basis: resolved.rule.legal_basis,
        effective_start: resolved.rule.effective_start,
        effective_end: resolved.rule.effective_end,
        time_zone: resolved.rule.time_zone,
      },
      category,
      rate: rate.rate,
      exempt: rate.exempt,
      exemption: rate.exemption,
      tier: rate.tier,
    };
  }

  explain(entryId) {
    return explainEntry(this.state(), entryId);
  }

  chain(entryId) {
    return entryChain(this.state(), entryId);
  }

  auditLot(lotId) {
    return auditDoubleTaxation(this.state(), lotId);
  }

  bom(lotId) {
    return traceBom(this.state(), lotId);
  }

  listFilings() {
    return [...this.state().filings.values()];
  }

  // 申报试算（不提交）。
  dryRunFiling(cmd) {
    return validateFiling(this.state(), cmd);
  }
}

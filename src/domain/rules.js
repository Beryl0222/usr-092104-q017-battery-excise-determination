// 法规版本时间线。每条版本是左闭右开区间 [effective_from, effective_to)，
// 比较一律使用绝对时刻（epoch ms），因此“九月一日零点”按各自时区解释后仍然确定。
// 阶段性免税只是 is_exempt=true 且区间有限的版本；到期自动落到后继版本，无需人工切换。

import { fold } from "./store.js";

export function projectRules(events) {
  return fold(
    events,
    () => ({ versions: new Map(), rules: new Map() }),
    {
      RULE_VERSION_PUBLISHED: (s, e) => {
        const p = e.payload;
        const v = {
          rule_id: p.rule_id,
          version_no: p.rule_version_no,
          citation: p.citation,
          tax_scope: p.tax_scope,
          applies_scopes: new Set(p.applies_scopes ?? [p.tax_scope]),
          rate: p.rate,
          is_exempt: p.is_exempt,
          rate_basis: p.rate_basis ?? "ad_valorem",
          effective_from_ms: Date.parse(p.effective_from),
          effective_to_ms: p.effective_to ? Date.parse(p.effective_to) : Infinity,
          effective_from_raw: p.effective_from,
          effective_to_raw: p.effective_to ?? null,
          published_at_ms: Date.parse(p.published_at),
          superseded: false,
        };
        if (!s.rules.has(p.rule_id)) s.rules.set(p.rule_id, []);
        s.rules.get(p.rule_id).push(v);
        s.versions.set(`${p.rule_id}@${p.rule_version_no}`, v);
      },
      RULE_REPEALED: (s, e) => {
        const v = s.versions.get(`${e.payload.rule_id}@${e.payload.rule_version_no}`);
        if (v) {
          v.effective_to_ms = Math.min(v.effective_to_ms, Date.parse(e.payload.repealed_at));
          v.superseded = true;
        }
      },
    },
  );
}

// 在某一法定时点（绝对时刻）解析某征税范围适用的版本。
// - 多个区间重叠时取发布时间更晚者；
// - 应税版本与免税版本同时命中且无法靠发布时间裁决时：
//   preferExemption=true（分类已由技术证据确认为免税对象）才取免税版本，
//   否则抛错——免税不得仅凭名称或归属自动获得。
export function resolveForScope(rulesState, taxScope, atMs, { preferExemption = false } = {}) {
  const hits = [];
  for (const versions of rulesState.rules.values()) {
    for (const v of versions) {
      if (v.applies_scopes.has(taxScope) && atMs >= v.effective_from_ms && atMs < v.effective_to_ms) {
        hits.push(v);
      }
    }
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  hits.sort((a, b) => b.published_at_ms - a.published_at_ms);
  if (hits[0].published_at_ms !== hits[1].published_at_ms) return hits[0];

  const exempt = hits.filter((v) => v.is_exempt);
  const taxable = hits.filter((v) => !v.is_exempt);
  if (exempt.length === 1 && taxable.length >= 1 && preferExemption) return exempt[0];
  throw new Error(
    `征税范围 ${taxScope} 在 ${new Date(atMs).toISOString()} 同时命中应税与免税版本且无优先级：` +
      hits.map((v) => `${v.rule_id}@${v.version_no}(${v.is_exempt ? "免税" : `${v.rate * 100}%`})`).join("、"),
  );
}

// 返回时间线上的边界时刻，供重放测试枚举。
export function boundaryMoments(rulesState) {
  const out = [];
  for (const versions of rulesState.rules.values()) {
    for (const v of versions) {
      out.push({ rule_id: v.rule_id, version_no: v.version_no, atMs: v.effective_from_ms, kind: "from" });
      if (Number.isFinite(v.effective_to_ms)) {
        out.push({ rule_id: v.rule_id, version_no: v.version_no, atMs: v.effective_to_ms, kind: "to" });
      }
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

// 凭证账与申报：原分录不可变，所有更正通过冲正（反符号）与补充分录表达。
// 申报批次一旦提交即锁定，其包含的分录集合不可变更。

import { localDayOf } from "./time.js";

export function isLive(entry) {
  return entry.kind === "initial";
}

// 取某供应当前仍然有效的初始分录（未被冲正的至多一条）。
export function liveInitialEntries(state, supplyId) {
  const ids = state.entriesBySupply.get(supplyId) || [];
  return ids
    .map((id) => state.entries.get(id))
    .filter((e) => e && e.kind === "initial" && e.reversed_by.length === 0);
}

// 分录的完整更正链：原分录、冲正、补充、关联复核、所在申报。
export function entryChain(state, entryId) {
  const root = state.entries.get(entryId);
  if (!root) return null;
  const head = root.kind === "initial" ? root : state.entries.get(root.reverses || root.supplements) || root;

  const related = [];
  const walk = (id) => {
    const e = state.entries.get(id);
    if (!e || related.some((r) => r.entry_id === id)) return;
    related.push(e);
    for (const r of e.reversed_by) walk(r);
    for (const s of e.supplements) walk(s);
  };
  walk(head.entry_id);
  if (root !== head) related.unshift(root);

  const reviews = state.reviews.filter((r) => r.entry_ids.includes(head.entry_id) || r.entry_ids.includes(entryId));
  const filings = [...state.filings.values()].filter(
    (f) => f.entry_ids.includes(head.entry_id) || f.entry_ids.includes(entryId)
  );

  const net = related.reduce((sum, e) => sum + (e.tax_amount || 0), 0);
  return {
    head_entry_id: head.entry_id,
    entries: related.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at)),
    reviews,
    filings,
    net_amount: net,
    currency: head.currency,
  };
}

// 申报前校验：分录存在、期间匹配、不得重复申报、合计一致。
export function validateFiling(state, { filing_id, period_start, period_end, entry_ids, submitted_at }) {
  const errors = [];
  const seen = new Set();
  let total = 0;
  let currency = null;

  for (const id of entry_ids) {
    if (seen.has(id)) errors.push(`分录 ${id} 在本申报中重复列入`);
    seen.add(id);
    const entry = state.entries.get(id);
    if (!entry) {
      errors.push(`分录 ${id} 不存在`);
      continue;
    }
    // 已提交（锁定）申报不得再次包含同一分录——原申报不被覆盖。
    for (const f of state.filings.values()) {
      if (f.filing_id !== filing_id && f.entry_ids.includes(id)) {
        errors.push(`分录 ${id} 已包含在申报批次 ${f.filing_id} 中，不得重复申报`);
      }
    }
    // 冲正分录没有 rule_code，沿链回溯到原初始分录的法规时区。
    const ref =
      entry.kind === "reversal" && entry.reverses
        ? state.entries.get(entry.reverses)
        : entry;
    const day = ref?.rule_code
      ? localDayOf(entry.taxable_event_at, tzFor(state, ref))
      : localDayOf(entry.taxable_event_at, "UTC");
    if (day < period_start || day > period_end) {
      errors.push(`分录 ${id} 的应税日 ${day} 不在申报期间 ${period_start} ~ ${period_end}`);
    }
    total += entry.tax_amount || 0;
    currency ||= entry.currency;
  }

  return { ok: errors.length === 0, errors, computed_total: round2(total), currency };
}

function tzFor(state, entry) {
  const versions = state.rules.get(entry.rule_code) || [];
  const match = versions.find((r) => r.rule_version === entry.rule_version);
  return match?.time_zone || "UTC";
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

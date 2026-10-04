// 凭证后端：计税结论登记、会计分录、申报批次及其后续更正。
// 不可变原则：
//   ENTRY_POSTED、FILING_SUBMITTED 一经追加即事实，不得修改或删除；
//   退货、折让、用途变化、税务复核只通过 ENTRY_ADJUSTED（reversal/supplement）表达，
//   归属更正发生的当期申报批次；同一计税结论只能进入一个申报批次，更正不重复计税。

import { fold } from "./store.js";

// 追加凭证类事件前，把“新事件并入既有日志”整体重放一遍：
// 折叠处理器中的不变量（禁止重复入账、禁止重复计税、更正必须引用原分录与所属申报期）
// 一旦违反即抛错，原事件不会进入日志。
export function appendVoucherEvent(store, event) {
  projectVouchers([...store.events, event]);
  return store.append(event);
}

export function projectVouchers(events) {
  return fold(
    events,
    () => ({
      assessments: new Map(), // assessment_id -> 结论
      entries: new Map(), // entry_id -> 分录
      filings: new Map(), // filing_id -> {period, assessments, entries, submitted}
      assessmentEntry: new Map(), // assessment_id -> entry_id
      entryAssessments: new Map(), // entry_id -> [assessment_id]
    }),
    {
      TAX_CALCULATED: (s, e) => {
        const p = e.payload;
        s.assessments.set(p.assessment_id, { ...p, recorded_at_ms: Date.parse(e.occurred_at) });
      },
      ENTRY_POSTED: (s, e) => {
        const p = e.payload;
        s.entries.set(p.entry_id, {
          entry_id: p.entry_id,
          assessment_ids: p.assessment_ids,
          debit_account: p.debit_account,
          credit_account: p.credit_account,
          amount: p.amount,
          currency: p.currency ?? "CNY",
          posted_at_ms: Date.parse(e.occurred_at),
          adjustments: [],
          original: true,
        });
        for (const id of p.assessment_ids) {
          if (s.assessmentEntry.has(id)) throw new Error(`计税结论 ${id} 已入账，禁止重复入账`);
          s.assessmentEntry.set(id, p.entry_id);
        }
        s.entryAssessments.set(p.entry_id, [...p.assessment_ids]);
      },
      FILING_SUBMITTED: (s, e) => {
        const p = e.payload;
        const ids = p.assessment_ids ?? [];
        for (const id of ids) {
          if (!s.assessments.has(id)) throw new Error(`申报引用了不存在的计税结论：${id}`);
          for (const f of s.filings.values()) {
            if (f.assessment_ids.has(id)) throw new Error(`计税结论 ${id} 已在申报批次 ${f.filing_id} 中申报，禁止重复计税`);
          }
        }
        s.filings.set(p.filing_id, {
          filing_id: p.filing_id,
          period: p.period,
          assessment_ids: new Set(p.assessment_ids),
          adjustment_entry_ids: new Set(p.adjustment_entry_ids ?? []),
          submitted_at_ms: Date.parse(p.submitted_at),
        });
      },
      ENTRY_ADJUSTED: (s, e) => {
        const p = e.payload;
        const original = s.entries.get(p.original_entry_id);
        if (!original) throw new Error(`更正分录引用了不存在的原分录：${p.original_entry_id}`);
        if (!s.filings.has(p.filing_id)) throw new Error("更正分录必须先有所属（当期）申报批次");
        const adj = {
          adjustment_entry_id: p.adjustment_entry_id,
          original_entry_id: p.original_entry_id,
          filing_id: p.filing_id,
          adjustment_type: p.adjustment_type, // reversal | supplement
          reason_code: p.reason_code,
          amount: p.amount, // 带符号：冲正一般为负，补提为正；金额方向以分录为准
          ref_event_id: p.ref_event_id ?? null,
          memo: p.memo ?? "",
          posted_at_ms: Date.parse(e.occurred_at),
        };
        original.adjustments.push(adj);
        s.filings.get(p.filing_id).adjustment_entry_ids.add(p.adjustment_entry_id);
      },
    },
  );
}

// 构造一条更正分录的语义内容（不含事件信封），保证四类原因的方向一致：
// 退货/折让 -> reversal（负），用途变化/复核/价格更正按重新计算差额决定方向。
export function planAdjustment({ originalEntry, recomputedTaxAmount, reasonCode, filingId, refEventId, memo }) {
  const delta = Math.round((recomputedTaxAmount - originalEntry.amount) * 100) / 100;
  const type = delta < 0 ? "reversal" : "supplement";
  return {
    adjustment_type: type,
    reason_code: reasonCode,
    original_entry_id: originalEntry.entry_id,
    filing_id: filingId,
    amount: delta,
    ref_event_id: refEventId ?? null,
    memo: memo ?? "",
  };
}

// 某条原分录取全部更正后的净额（原申报数不变，净额仅供展示与审计）。
export function netAmount(entry) {
  return Math.round((entry.amount + entry.adjustments.reduce((s, a) => s + a.amount, 0)) * 100) / 100;
}

export function filingTotals(filing, vouchers) {
  let original = 0;
  for (const id of filing.assessment_ids) {
    const entryId = vouchers.assessmentEntry.get(id);
    const entry = vouchers.entries.get(entryId);
    if (entry) original += entry.amount;
  }
  let adjustments = 0;
  for (const entry of vouchers.entries.values()) {
    for (const a of entry.adjustments) {
      if (a.filing_id === filing.filing_id) adjustments += a.amount;
    }
  }
  return {
    period: filing.period,
    original_declared: Math.round(original * 100) / 100,
    adjustments_in_period: Math.round(adjustments * 100) / 100,
    net_payable: Math.round((original + adjustments) * 100) / 100,
  };
}

// 审计追溯：从整车或储能模组（作为生产批次）沿 COMPONENT_CONSUMED 递归追到所含电芯批次，
// 再沿计税结论 -> 会计分录 -> 申报批次 -> 更正分录正向展开。
// 已税扣除在计税时按凭证封顶，追溯视图同时展示“母级已申报”与“子级已纳凭证”，避免重复计税争议。

export function traceLot(lotId, ops, vouchers, depth = 0, seen = new Set()) {
  const lot = ops.lots.get(lotId);
  if (!lot) return null;
  if (seen.has(lotId)) return { lot_id: lotId, cycle: true };
  seen.add(lotId);

  const childTraces = lot.components.map((c) => ({
    ...traceLot(c.component_lot_id, ops, vouchers, depth + 1, seen),
    consumed_quantity: c.quantity,
  })).filter(Boolean);

  const assessments = [...vouchers.assessments.values()].filter((a) => a.lot_id === lotId);
  const assessmentViews = assessments.map((a) => {
    const entryId = vouchers.assessmentEntry.get(a.assessment_id);
    const entry = entryId ? vouchers.entries.get(entryId) : null;
    const filing = entry
      ? [...vouchers.filings.values()].find((f) => f.assessment_ids.has(a.assessment_id))
      : null;
    return {
      assessment_id: a.assessment_id,
      tax_point: a.tax_point_id,
      tax_amount: a.tax_amount,
      rule: a.explanation?.rule_application ?? null,
      entry: entry && {
        entry_id: entry.entry_id,
        amount: entry.amount,
        posted_at_ms: entry.posted_at_ms,
        adjustments: entry.adjustments,
        net_amount: Math.round(
          (entry.amount + entry.adjustments.reduce((s, x) => s + x.amount, 0)) * 100,
        ) / 100,
      },
      filing: filing && { filing_id: filing.filing_id, period: filing.period, submitted_at_ms: filing.submitted_at_ms },
    };
  });

  return {
    lot_id: lotId,
    profile_id: lot.profile_id,
    quantity: lot.quantity,
    completed_at_ms: lot.completed_at_ms,
    components: childTraces,
    assessments: assessmentViews,
    leaf: childTraces.length === 0,
  };
}

// 汇总：某模组/整车追溯链中所有已申报税额（仅母级直接销售的评估），
// 以及子批次作为已税扣除凭证使用的税额，供审计核对不重复计税。
export function traceSummary(trace) {
  let declared = 0;
  let declaredNet = 0;
  const declaredAt = [];
  const walk = (node) => {
    if (node.cycle) return;
    for (const a of node.assessments ?? []) {
      if (a.entry) {
        declared += a.entry.amount;
        declaredNet += a.entry.net_amount;
        declaredAt.push({ lot_id: node.lot_id, entry_id: a.entry.entry_id, amount: a.entry.amount });
      }
    }
    for (const c of node.components ?? []) walk(c);
  };
  walk(trace);
  return {
    declared_total: Math.round(declared * 100) / 100,
    declared_net_total: Math.round(declaredNet * 100) / 100,
    declared_at: declaredAt,
  };
}

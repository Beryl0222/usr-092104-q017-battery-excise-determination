// 事件折叠投影：从领域事件流重建当前状态（或某历史时刻状态）。
// 纯函数、无副作用；时间旅行通过先过滤 occurred_at <= asOf 再 fold 实现。

import { EventType } from "./events.js";

export function fold(events) {
  const state = {
    rules: new Map(), // rule_code -> [版本...] 按 effective_start
    rulesById: new Map(), // aggregateId -> rule
    profiles: new Map(), // profile_id -> profile
    evidence: new Map(), // profile_id -> [evidence...]
    proposals: new Map(), // profile_id -> [proposal...]
    signings: new Map(), // profile_id -> [signing...]
    lots: new Map(), // lot_id -> lot
    supplies: new Map(), // supply_id -> supply
    invoices: new Map(), // invoice_id -> invoice
    entries: new Map(), // entry_id -> entry record（含 kind 与链）
    entriesBySupply: new Map(), // supply_id -> [entry_id...]
    reviews: [],
    filings: new Map(), // filing_id -> filing
    raw: events,
  };

  for (const e of events) apply(state, e);
  return state;
}

function apply(state, e) {
  const p = e.payload || {};
  switch (e.event_type) {
    case EventType.RULE_EFFECTIVE: {
      const rule = {
        rule_code: p.rule_code,
        rule_version: p.rule_version,
        title: p.title,
        legal_basis: p.legal_basis,
        effective_start: p.effective_start,
        effective_end: p.effective_end || null,
        time_zone: p.time_zone,
        categories: p.categories || [],
        replaces_version: p.replaces_version || null,
        timing_policy: p.timing_policy || "cn_goods_default",
        rounding: p.rounding || null,
        registered_event: e.event_id,
        registered_at: e.occurred_at,
      };
      const list = state.rules.get(rule.rule_code) || [];
      list.push(rule);
      list.sort((a, b) => a.effective_start.localeCompare(b.effective_start));
      state.rules.set(rule.rule_code, list);
      state.rulesById.set(e.aggregate_id, rule);
      break;
    }
    case EventType.PROFILE_REGISTERED: {
      state.profiles.set(p.profile_id, {
        profile_id: p.profile_id,
        market_name: p.market_name,
        declared_form: p.declared_form,
        attributes: p.attributes || {},
        supplier_id: p.supplier_id || null,
        name_history: [{ name: p.market_name, from: e.occurred_at, reason: "registered" }],
      });
      break;
    }
    case EventType.PROFILE_RENAMED: {
      const profile = state.profiles.get(p.profile_id);
      if (profile) {
        profile.market_name = p.new_name;
        profile.name_history.push({ name: p.new_name, from: p.renamed_at, reason: p.reason || "renamed", old_name: p.old_name });
      }
      break;
    }
    case EventType.EVIDENCE_ATTACHED: {
      const list = state.evidence.get(p.profile_id) || [];
      list.push({ ...p, event_id: e.event_id });
      state.evidence.set(p.profile_id, list);
      break;
    }
    case EventType.CLASSIFICATION_PROPOSED: {
      const list = state.proposals.get(p.profile_id) || [];
      list.push({ ...p, event_id: e.event_id, proposed_at: e.occurred_at });
      state.proposals.set(p.profile_id, list);
      break;
    }
    case EventType.CLASSIFICATION_SIGNED: {
      const list = state.signings.get(p.profile_id) || [];
      list.push({ ...p, event_id: e.event_id });
      state.signings.set(p.profile_id, list);
      break;
    }
    case EventType.LOT_RECORDED: {
      state.lots.set(p.lot_id, {
        lot_id: p.lot_id,
        profile_id: p.profile_id,
        produced_at: p.produced_at,
        completed_at: null,
        inspection_ref: null,
        quantity: p.quantity,
        unit: p.unit,
        plant_id: p.plant_id || null,
        components: [], // 所含下层批次
        parents: [], // 被哪些上层批次耗用
        usage: "sale",
        usage_history: [],
      });
      break;
    }
    case EventType.LOT_COMPLETED: {
      const lot = state.lots.get(p.lot_id);
      if (lot) {
        lot.completed_at = p.completed_at;
        lot.inspection_ref = p.inspection_ref || lot.inspection_ref;
      }
      break;
    }
    case EventType.LOT_BOM_LINKED: {
      const parentId = p.module_lot_id || p.parent_lot_id;
      const child = state.lots.get(p.lot_id);
      const parent = state.lots.get(parentId);
      if (child && parent) {
        child.parents.push({ parent_lot_id: parentId, quantity_consumed: p.quantity_consumed, unit: p.unit, at: e.occurred_at });
        parent.components.push({ component_lot_id: p.lot_id, quantity_consumed: p.quantity_consumed, unit: p.unit, at: e.occurred_at });
      }
      break;
    }
    case EventType.LOT_USAGE_CHANGED: {
      const lot = state.lots.get(p.lot_id);
      if (lot) {
        lot.usage_history.push({ old_usage: p.old_usage, new_usage: p.new_usage, changed_at: p.changed_at, reason: p.reason || null });
        lot.usage = p.new_usage;
      }
      break;
    }
    case EventType.SUPPLY_CONTRACTED: {
      state.supplies.set(p.supply_id, {
        supply_id: p.supply_id,
        lot_id: p.lot_id,
        profile_id: p.profile_id,
        counterparty: p.counterparty,
        contract: { ...p },
        invoices: [],
        dispatch: null,
      });
      break;
    }
    case EventType.INVOICE_ISSUED: {
      state.invoices.set(p.invoice_id, { ...p, event_id: e.event_id });
      const supply = state.supplies.get(p.supply_id);
      if (supply) supply.invoices.push(p.invoice_id);
      break;
    }
    case EventType.SUPPLY_DISPATCHED: {
      const supply = state.supplies.get(p.supply_id);
      if (supply) supply.dispatch = { ...p };
      break;
    }
    case EventType.TAX_CALCULATED: {
      state.entries.set(p.entry_id, {
        entry_id: p.entry_id,
        kind: "initial",
        supply_id: p.supply_id || null,
        lot_id: p.lot_id,
        profile_id: p.profile_id,
        taxable_event: p.taxable_event,
        taxable_event_at: p.taxable_event_at,
        rule_code: p.rule_code,
        rule_version: p.rule_version,
        category: p.category,
        rate: p.rate,
        exempt: p.exempt,
        tax_basis_price: p.tax_basis_price,
        currency: p.currency,
        quantity: p.quantity,
        tax_amount: p.tax_amount,
        explanation: p.explanation,
        reversed_by: [],
        supplements: [],
        reverses: null,
        event_id: e.event_id,
        recorded_at: e.occurred_at,
      });
      if (p.supply_id) {
        const list = state.entriesBySupply.get(p.supply_id) || [];
        list.push(p.entry_id);
        state.entriesBySupply.set(p.supply_id, list);
      }
      break;
    }
    case EventType.ENTRY_REVERSED: {
      state.entries.set(p.entry_id, {
        entry_id: p.entry_id,
        kind: "reversal",
        reverses: p.reverses_entry_id,
        supply_id: p.supply_id || null,
        lot_id: p.lot_id,
        reason_code: p.reason_code,
        reason_ref: p.reason_ref || null,
        taxable_event_at: p.reversed_at,
        tax_amount: p.tax_amount,
        quantity: p.quantity ?? null,
        currency: null,
        explanation: p.explanation,
        reversed_by: [],
        supplements: [],
        event_id: e.event_id,
        recorded_at: e.occurred_at,
      });
      const original = state.entries.get(p.reverses_entry_id);
      if (original) original.reversed_by.push(p.entry_id);
      break;
    }
    case EventType.ENTRY_ADDED: {
      state.entries.set(p.entry_id, {
        entry_id: p.entry_id,
        kind: "supplement",
        supplements: p.supplements_entry_id || null,
        supply_id: p.supply_id || null,
        lot_id: p.lot_id,
        profile_id: p.profile_id,
        reason_code: p.reason_code,
        taxable_event_at: p.taxable_event_at,
        rule_code: p.rule_code,
        rule_version: p.rule_version,
        category: p.category,
        rate: p.rate,
        exempt: p.exempt,
        tax_basis_price: p.tax_basis_price,
        currency: p.currency,
        quantity: p.quantity,
        tax_amount: p.tax_amount,
        explanation: p.explanation,
        reversed_by: [],
        supplements: [],
        event_id: e.event_id,
        recorded_at: e.occurred_at,
      });
      if (p.supplements_entry_id) {
        const original = state.entries.get(p.supplements_entry_id);
        if (original) original.supplements.push(p.entry_id);
      }
      if (p.supply_id) {
        const list = state.entriesBySupply.get(p.supply_id) || [];
        list.push(p.entry_id);
        state.entriesBySupply.set(p.supply_id, list);
      }
      break;
    }
    case EventType.TAX_REVIEWED: {
      state.reviews.push({ ...p, event_id: e.event_id });
      break;
    }
    case EventType.FILING_SUBMITTED: {
      state.filings.set(p.filing_id, {
        filing_id: p.filing_id,
        period_start: p.period_start,
        period_end: p.period_end,
        submitted_at: p.submitted_at,
        entry_ids: [...p.entry_ids],
        total_tax_amount: p.total_tax_amount,
        currency: p.currency,
        status: "submitted",
        settled_at: null,
      });
      break;
    }
    case EventType.FILING_SETTLED: {
      const filing = state.filings.get(p.filing_id);
      if (filing) {
        filing.status = "settled";
        filing.settled_at = p.settled_at;
        filing.reference = p.reference || null;
      }
      break;
    }
    case EventType.ENTRY_ADJUSTED:
    case EventType.LOT_CLASSIFIED:
      // 历史事件仅留痕，新业务通过分类签署/冲正/补充分录表达
      break;
    default:
      break;
  }
}

// 在某时刻有效的授权分类签署（valid_from <= day，valid_until 未过）。
export function effectiveSigning(state, profileId, instant) {
  const t = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  const signings = state.signings.get(profileId) || [];
  const valid = signings
    .filter((s) => Date.parse(s.valid_from) <= t)
    .filter((s) => !s.valid_until || Date.parse(s.valid_until) > t)
    .sort((a, b) => Date.parse(b.signed_at) - Date.parse(a.signed_at));
  return valid[0] || null;
}

// 某批次截至某时刻的净额（初始 + 补充 + 冲正）。
export function netTaxByLot(state, lotId) {
  let amount = 0;
  const ids = [];
  for (const [id, entry] of state.entries) {
    if (entry.lot_id === lotId) {
      amount += entry.tax_amount;
      ids.push(id);
    }
  }
  return { amount, entry_ids: ids };
}

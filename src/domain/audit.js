// 审计读模型：从整车/储能模组向下追溯所含批次、各批次税额与更正链，检测重复计税。
// BOM 边来自 LOT_BOM_LINKED（沿用仓库领域事件标识），不依赖产品市场名称。

import { netTaxByLot } from "./projections.js";
import { entryChain } from "./ledger.js";

// 递归展开 BOM，返回树与扁平清单（嵌套数量按各层耗用量连乘；跨单位换算在证据齐备前不自动进行）。
export function traceBom(state, rootLotId) {
  const root = state.lots.get(rootLotId);
  if (!root) return null;
  const flat = [];

  const visit = (lotId, depth, parentEdge, factor, path) => {
    const lot = state.lots.get(lotId);
    if (!lot) return null;
    const node = {
      lot_id: lotId,
      profile_id: lot.profile_id,
      depth,
      parent_lot_id: parentEdge?.parent_lot_id || null,
      edge_quantity_consumed: parentEdge?.quantity_consumed ?? null,
      edge_unit: parentEdge?.unit || null,
      nested_quantity: factor * (parentEdge?.quantity_consumed ?? 1),
      lot_quantity: lot.quantity,
      lot_unit: lot.unit,
      path: [...path, lotId],
      components: [],
    };
    if (flat.some((n) => n.lot_id === lotId && n.path.join(">") === node.path.join(">"))) return node;
    flat.push(node);
    for (const edge of lot.components || []) {
      const child = visit(
        edge.component_lot_id,
        depth + 1,
        { parent_lot_id: lotId, quantity_consumed: edge.quantity_consumed, unit: edge.unit },
        factor * edge.quantity_consumed,
        node.path
      );
      if (child) node.components.push(child);
    }
    return node;
  };

  const tree = visit(rootLotId, 0, null, 1, []);
  return { tree, flat };
}

// 沿父级向上找所有已税祖先（存在净额非零分录的批次）。
function taxedAncestors(state, node) {
  const ancestors = [];
  for (let i = 0; i < node.path.length - 1; i++) {
    const ancestorLotId = node.path[i];
    const net = netTaxByLot(state, ancestorLotId);
    if (net.amount !== 0) ancestors.push({ lot_id: ancestorLotId, net: net.amount, entry_ids: net.entry_ids });
  }
  return ancestors;
}

// 重复计税审计：组件批次与任一上层批次同时承担税额即标记（消费税单一环节原则）。
export function auditDoubleTaxation(state, rootLotId) {
  const traced = traceBom(state, rootLotId);
  if (!traced) return { ok: false, error: `批次不存在：${rootLotId}` };

  const flags = [];
  for (const node of traced.flat) {
    if (node.depth === 0) continue;
    const net = netTaxByLot(state, node.lot_id);
    if (net.amount === 0) continue;
    const ancestors = taxedAncestors(state, node);
    for (const ancestor of ancestors) {
      flags.push({
        type: "potential_double_taxation",
        component_lot_id: node.lot_id,
        taxed_at_ancestor_lot_id: ancestor.lot_id,
        component_net_tax: net.amount,
        ancestor_net_tax: ancestor.net,
        component_entry_ids: net.entry_ids,
        ancestor_entry_ids: ancestor.entry_ids,
        hint: "组件与上层成品均计税；应通过冲正/补充分录体现已纳消费税扣除或环节豁免，不得重复负担。",
      });
    }
  }

  const rootNet = netTaxByLot(state, rootLotId);
  return {
    ok: true,
    root_lot_id: rootLotId,
    tree: traced.tree,
    flat: traced.flat.map(({ path, ...n }) => n),
    root_net_tax: rootNet.amount,
    lot_tax: traced.flat.map((n) => ({ lot_id: n.lot_id, depth: n.depth, ...netTaxByLot(state, n.lot_id) })),
    double_taxation_flags: flags,
  };
}

// 单笔税额的完整解释：法规快照、分类签署与证据、价格来源、时点推导、更正链、申报落点。
export function explainEntry(state, entryId) {
  const entry = state.entries.get(entryId);
  if (!entry) return { ok: false, error: `分录不存在：${entryId}` };
  const chain = entryChain(state, entryId);
  const profile = state.profiles.get(entry.profile_id);
  const evidenceList = entry.profile_id ? state.evidence.get(entry.profile_id) || [] : [];
  const signing = pickSigningForEntry(state, entry);

  return {
    ok: true,
    entry: {
      entry_id: entry.entry_id,
      kind: entry.kind,
      tax_amount: entry.tax_amount,
      taxable_event: entry.taxable_event || null,
      taxable_event_at: entry.taxable_event_at,
      recorded_at: entry.recorded_at,
    },
    rule: entry.rule_code
      ? {
          rule_code: entry.rule_code,
          rule_version: entry.rule_version,
          snapshot:
            (state.rules.get(entry.rule_code) || []).find((r) => r.rule_version === entry.rule_version) || null,
        }
      : null,
    classification: signing
      ? {
          category: signing.category,
          signer: signing.signer,
          signer_role: signing.signer_role,
          signed_at: signing.signed_at,
          boundary: signing.boundary,
          evidence_refs: signing.evidence_refs,
        }
      : null,
    evidence: evidenceList.map((e) => ({
      evidence_type: e.evidence_type,
      evidence_ref: e.evidence_ref,
      issuer: e.issuer,
      issued_at: e.issued_at,
      attributes_verified: e.attributes_verified,
      valid_until: e.valid_until || null,
    })),
    market_name_trace: profile
      ? { profile_id: profile.profile_id, current_name: profile.market_name, name_history: profile.name_history }
      : null,
    calculation: entry.explanation,
    correction_chain: chain
      ? {
          entries: chain.entries.map((e) => ({
            entry_id: e.entry_id,
            kind: e.kind,
            tax_amount: e.tax_amount,
            reason_code: e.reason_code || null,
            recorded_at: e.recorded_at,
          })),
          net_amount: chain.net_amount,
          reviews: chain.reviews,
        }
      : null,
    filings: chain?.filings.map((f) => ({ filing_id: f.filing_id, status: f.status, period: [f.period_start, f.period_end] })) || [],
  };
}

function pickSigningForEntry(state, entry) {
  if (!entry.profile_id) return null;
  const t = Date.parse(entry.taxable_event_at);
  const signings = (state.signings.get(entry.profile_id) || [])
    .filter((s) => Date.parse(s.valid_from) <= t)
    .filter((s) => !s.valid_until || Date.parse(s.valid_until) > t)
    .sort((a, b) => Date.parse(b.signed_at) - Date.parse(a.signed_at));
  return signings[0] || null;
}

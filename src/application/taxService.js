// 应用命令服务：鉴权、不变量校验、事件产出。所有状态经 fold(store.stream()) 实时重建。
import { randomUUID } from "node:crypto";
import { EventType, AggregateType, isValidDateTime } from "../domain/events.js";
import { fold } from "../domain/projections.js";
import { classify } from "../domain/classification.js";
import { calculateTax, resolveRule } from "../domain/taxation.js";
import { intervalsOverlap } from "../domain/time.js";
import { validateFiling, liveInitialEntries } from "../domain/ledger.js";

export const Role = Object.freeze({
  RULE_ADMIN: "rule_admin", // 维护法规版本
  TAX_OFFICER: "tax_officer", // 授权签署边界分类、税务复核
  FINANCE: "finance", // 计税、开票、申报、更正
  TECHNICAL: "technical", // 补充技术属性与检验证据
  WAREHOUSE: "warehouse", // 入库/出库/BOM 事件来源
  AUDITOR: "auditor", // 只读
});

const BOUNDARY_SIGNER_ROLES = new Set([Role.TAX_OFFICER]);

export class TaxService {
  constructor(store, { now, defaultRuleCode = "LI_EXCISE" } = {}) {
    this.store = store;
    this.clock = now || (() => new Date());
    this.defaultRuleCode = defaultRuleCode;
  }

  state(asOf) {
    return fold(this.store.stream(asOf ? { asOf } : undefined));
  }

  nowIso(zoneOffset = "+08:00") {
    return new Date(this.clock().getTime()).toISOString();
  }

  requireRole(actor, ...roles) {
    if (!actor?.roles?.some((r) => roles.includes(r))) {
      const err = new Error(`角色不足：需要 ${roles.join(" 或 ")}`);
      err.code = "FORBIDDEN";
      throw err;
    }
  }

  #envelope({ type, aggregateType, aggregateId, occurredAt, summary, payload, idempotencyKey, causationId, source }) {
    const version = (this.store.versions.get(aggregateId) || 0) + 1;
    const at = occurredAt || this.nowIso();
    if (!isValidDateTime(at)) throw new Error("时刻必须带时区偏移（RFC3339）");
    return {
      event_id: `evt-${randomUUID()}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: at,
      version,
      summary,
      source: source || "tax-ledger",
      payload,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(causationId ? { causation_id: causationId } : {}),
    };
  }

  async #publish(events) {
    const out = [];
    for (const e of events) out.push(await this.store.append(e));
    return out;
  }

  // ---------- 法规版本 ----------
  async registerRule(actor, cmd) {
    this.requireRole(actor, Role.RULE_ADMIN, Role.TAX_OFFICER);
    const state = this.state();
    const versions = state.rules.get(cmd.rule_code) || [];
    for (const v of versions) {
      if (v.rule_version === cmd.rule_version) throw new Error(`法规版本已存在：${cmd.rule_code}#${cmd.rule_version}`);
      if (intervalsOverlap(v, cmd)) {
        const err = new Error(`法规版本生效区间与 ${v.rule_version}（${v.effective_start}~${v.effective_end || "开放"}）重叠`);
        err.code = "RULE_INTERVAL_OVERLAP";
        throw err;
      }
    }
    const event = this.#envelope({
      type: EventType.RULE_EFFECTIVE,
      aggregateType: AggregateType.TAX_RULE,
      aggregateId: `${cmd.rule_code}#${cmd.rule_version}`,
      occurredAt: cmd.occurred_at,
      summary: `法规 ${cmd.rule_code} v${cmd.rule_version} 生效（${cmd.effective_start} 起）`,
      payload: {
        rule_code: cmd.rule_code,
        rule_version: cmd.rule_version,
        title: cmd.title,
        legal_basis: cmd.legal_basis,
        effective_start: cmd.effective_start,
        effective_end: cmd.effective_end || null,
        time_zone: cmd.time_zone,
        categories: cmd.categories,
        replaces_version: cmd.replaces_version || null,
        ...(cmd.timing_policy ? { timing_policy: cmd.timing_policy } : {}),
        ...(cmd.rounding ? { rounding: cmd.rounding } : {}),
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  // ---------- 产品档案 ----------
  async registerProfile(actor, cmd) {
    this.requireRole(actor, Role.TECHNICAL, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    if (state.profiles.has(cmd.profile_id)) throw new Error(`产品档案已存在：${cmd.profile_id}`);
    const event = this.#envelope({
      type: EventType.PROFILE_REGISTERED,
      aggregateType: AggregateType.PRODUCT_PROFILE,
      aggregateId: cmd.profile_id,
      occurredAt: cmd.occurred_at,
      summary: `登记产品技术档案（市场名称不作为计税依据）`,
      payload: {
        profile_id: cmd.profile_id,
        market_name: cmd.market_name,
        declared_form: cmd.declared_form,
        prior_names: cmd.prior_names || [],
        attributes: cmd.attributes,
        supplier_id: cmd.supplier_id || null,
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  // 改名只留痕，绝不改变分类；任何角色都无法借改名获得免税。
  async renameProfile(actor, cmd) {
    this.requireRole(actor, Role.TECHNICAL, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    const profile = state.profiles.get(cmd.profile_id);
    if (!profile) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    const event = this.#envelope({
      type: EventType.PROFILE_RENAMED,
      aggregateType: AggregateType.PRODUCT_PROFILE,
      aggregateId: cmd.profile_id,
      occurredAt: cmd.occurred_at,
      summary: `产品改名：${profile.market_name} → ${cmd.new_name}（不影响税务分类）`,
      payload: {
        profile_id: cmd.profile_id,
        old_name: profile.market_name,
        new_name: cmd.new_name,
        renamed_at: cmd.renamed_at || cmd.occurred_at || this.nowIso(),
        reason: cmd.reason || null,
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  async attachEvidence(actor, cmd) {
    this.requireRole(actor, Role.TECHNICAL, Role.TAX_OFFICER);
    const state = this.state();
    if (!state.profiles.has(cmd.profile_id)) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    const event = this.#envelope({
      type: EventType.EVIDENCE_ATTACHED,
      aggregateType: AggregateType.CLASSIFICATION,
      aggregateId: `classification:${cmd.profile_id}`,
      occurredAt: cmd.occurred_at,
      summary: `补充证据 ${cmd.evidence_type}：${cmd.evidence_ref}`,
      payload: {
        profile_id: cmd.profile_id,
        evidence_type: cmd.evidence_type,
        evidence_ref: cmd.evidence_ref,
        issuer: cmd.issuer,
        issued_at: cmd.issued_at,
        attributes_verified: cmd.attributes_verified,
        valid_until: cmd.valid_until || null,
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  // 系统/人工提出候选分类：只列候选与缺失证据，不做终局认定。
  proposeClassification(actor, cmd) {
    const state = this.state();
    const profile = state.profiles.get(cmd.profile_id);
    if (!profile) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    const asOf = cmd.as_of || this.nowIso();
    const ruleResult = resolveRule(state.rules, cmd.rule_code || this.defaultRuleCode, asOf);
    if (!ruleResult.ok) throw new Error(ruleResult.error);
    const evidence = state.evidence.get(cmd.profile_id) || [];
    const result = classify({ profile, evidence, rule: ruleResult.rule, asOf });
    return { ...result, profile_id: cmd.profile_id, rule_code: ruleResult.rule.rule_code, rule_version: ruleResult.rule.rule_version };
  }

  async signClassification(actor, cmd) {
    this.requireRole(actor, Role.TAX_OFFICER);
    const state = this.state();
    const profile = state.profiles.get(cmd.profile_id);
    if (!profile) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    const asOf = cmd.signed_at || this.nowIso();
    const proposal = this.proposeClassification(actor, { ...cmd, as_of: asOf });

    const knownCategories = new Set(proposal.evaluations.map((e) => e.category));
    if (!knownCategories.has(cmd.category)) throw new Error(`签署税目 ${cmd.category} 不在当前法规版本内`);
    const candidate = proposal.candidates.find((c) => c.category === cmd.category);

    // 候选不匹配时，仅授权税务人员可作边界裁定，且必须书面说明；市场名称仍不参与。
    const adjudication = !candidate;
    if (adjudication) {
      if (!BOUNDARY_SIGNER_ROLES.has(actor.roles?.find((r) => BOUNDARY_SIGNER_ROLES.has(r)))) {
        const err = new Error(`税目 ${cmd.category} 不在候选内，只有授权税务人员可作边界裁定签署`);
        err.code = "BOUNDARY_SIGNATURE_REQUIRED";
        err.proposal = proposal;
        throw err;
      }
      if (!cmd.note) throw new Error("边界裁定签署必须填写 note 说明裁定依据");
    }

    const isBoundary = proposal.boundary || adjudication || !!cmd.boundary;
    if (isBoundary && !BOUNDARY_SIGNER_ROLES.has(actor.roles?.find((r) => BOUNDARY_SIGNER_ROLES.has(r)))) {
      const err = new Error("边界产品必须由授权税务人员签署");
      err.code = "BOUNDARY_SIGNATURE_REQUIRED";
      throw err;
    }
    const knownRefs = new Set((state.evidence.get(cmd.profile_id) || []).map((e) => e.evidence_ref));
    const unknown = (cmd.evidence_refs || []).filter((r) => !knownRefs.has(r));
    if (unknown.length) throw new Error(`签署引用了未登记证据：${unknown.join("、")}`);

    const event = this.#envelope({
      type: EventType.CLASSIFICATION_SIGNED,
      aggregateType: AggregateType.CLASSIFICATION,
      aggregateId: `classification:${cmd.profile_id}`,
      occurredAt: cmd.occurred_at,
      summary: `${isBoundary ? "边界产品" : "常规产品"}分类签署：${cmd.category}`,
      payload: {
        profile_id: cmd.profile_id,
        category: cmd.category,
        signer: actor.id,
        signer_role: actor.roles.find((r) => BOUNDARY_SIGNER_ROLES.has(r)) || actor.roles[0],
        signed_at: cmd.signed_at || this.nowIso(),
        evidence_refs: cmd.evidence_refs || [],
        boundary: isBoundary,
        valid_from: cmd.valid_from || asOf.slice(0, 10),
        valid_until: cmd.valid_until || null,
        note: cmd.note || null,
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  // ---------- 批次与 BOM ----------
  async recordLot(actor, cmd) {
    this.requireRole(actor, Role.WAREHOUSE, Role.TECHNICAL, Role.FINANCE);
    const state = this.state();
    if (state.lots.has(cmd.lot_id)) throw new Error(`批次已存在：${cmd.lot_id}`);
    if (!state.profiles.has(cmd.profile_id)) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    return this.#publish([
      this.#envelope({
        type: EventType.LOT_RECORDED,
        aggregateType: AggregateType.LOT,
        aggregateId: cmd.lot_id,
        occurredAt: cmd.occurred_at,
        summary: `批次建档 ${cmd.lot_id}`,
        payload: {
          lot_id: cmd.lot_id,
          profile_id: cmd.profile_id,
          produced_at: cmd.produced_at,
          quantity: cmd.quantity,
          unit: cmd.unit,
          plant_id: cmd.plant_id || null,
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async completeLot(actor, cmd) {
    this.requireRole(actor, Role.WAREHOUSE, Role.TECHNICAL);
    const state = this.state();
    const lot = state.lots.get(cmd.lot_id);
    if (!lot) throw new Error(`批次不存在：${cmd.lot_id}`);
    return this.#publish([
      this.#envelope({
        type: EventType.LOT_COMPLETED,
        aggregateType: AggregateType.LOT,
        aggregateId: cmd.lot_id,
        occurredAt: cmd.occurred_at,
        summary: `批次完工入库 ${cmd.lot_id}`,
        payload: { lot_id: cmd.lot_id, completed_at: cmd.completed_at, inspection_ref: cmd.inspection_ref || null },
        causationId: cmd.warehouse_event_id,
        source: cmd.source || "warehouse",
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async linkBom(actor, cmd) {
    this.requireRole(actor, Role.WAREHOUSE, Role.TECHNICAL);
    const state = this.state();
    const child = state.lots.get(cmd.lot_id);
    const parentId = cmd.module_lot_id || cmd.parent_lot_id;
    if (!child) throw new Error(`组件批次不存在：${cmd.lot_id}`);
    if (!state.lots.get(parentId)) throw new Error(`上层批次不存在：${parentId}`);
    return this.#publish([
      this.#envelope({
        type: EventType.LOT_BOM_LINKED,
        aggregateType: AggregateType.LOT,
        aggregateId: cmd.lot_id,
        occurredAt: cmd.occurred_at,
        summary: `BOM：批次 ${cmd.lot_id} 耗用于 ${parentId}`,
        payload: {
          lot_id: cmd.lot_id,
          parent_lot_id: cmd.parent_lot_id || null,
          module_lot_id: cmd.module_lot_id || null,
          quantity_consumed: cmd.quantity_consumed,
          unit: cmd.unit,
        },
        causationId: cmd.warehouse_event_id,
        source: cmd.source || "warehouse",
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async changeUsage(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER, Role.WAREHOUSE);
    const state = this.state();
    const lot = state.lots.get(cmd.lot_id);
    if (!lot) throw new Error(`批次不存在：${cmd.lot_id}`);
    if (lot.usage === cmd.new_usage) throw new Error(`批次 ${cmd.lot_id} 用途已是 ${cmd.new_usage}`);
    return this.#publish([
      this.#envelope({
        type: EventType.LOT_USAGE_CHANGED,
        aggregateType: AggregateType.LOT,
        aggregateId: cmd.lot_id,
        occurredAt: cmd.occurred_at,
        summary: `用途变化 ${lot.usage} → ${cmd.new_usage}（${cmd.lot_id}）`,
        payload: {
          lot_id: cmd.lot_id,
          old_usage: lot.usage,
          new_usage: cmd.new_usage,
          changed_at: cmd.changed_at || cmd.occurred_at || this.nowIso(),
          reason: cmd.reason || null,
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  // ---------- 销售时点 ----------
  async recordContract(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.WAREHOUSE);
    const state = this.state();
    if (state.supplies.has(cmd.supply_id)) throw new Error(`供应单已存在：${cmd.supply_id}`);
    return this.#publish([
      this.#envelope({
        type: EventType.SUPPLY_CONTRACTED,
        aggregateType: AggregateType.SUPPLY,
        aggregateId: cmd.supply_id,
        occurredAt: cmd.occurred_at,
        summary: `签订合同 ${cmd.supply_id}`,
        payload: {
          supply_id: cmd.supply_id,
          lot_id: cmd.lot_id,
          profile_id: cmd.profile_id,
          counterparty: cmd.counterparty,
          contracted_at: cmd.contracted_at,
          contracted_price: cmd.contracted_price,
          currency: cmd.currency || "CNY",
          quantity: cmd.quantity,
          unit: cmd.unit,
          settlement_terms: cmd.settlement_terms || null,
          payment_due_at: cmd.payment_due_at || null,
          payment_received_at: cmd.payment_received_at || null,
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async issueInvoice(actor, cmd) {
    this.requireRole(actor, Role.FINANCE);
    const state = this.state();
    if (state.invoices.has(cmd.invoice_id)) throw new Error(`发票已存在：${cmd.invoice_id}`);
    if (!state.supplies.get(cmd.supply_id)) throw new Error(`供应单不存在：${cmd.supply_id}`);
    return this.#publish([
      this.#envelope({
        type: EventType.INVOICE_ISSUED,
        aggregateType: AggregateType.INVOICE,
        aggregateId: cmd.invoice_id,
        occurredAt: cmd.occurred_at,
        summary: `开具发票 ${cmd.invoice_number || cmd.invoice_id}`,
        payload: {
          invoice_id: cmd.invoice_id,
          supply_id: cmd.supply_id,
          issued_at: cmd.issued_at,
          invoice_price: cmd.invoice_price,
          currency: cmd.currency || "CNY",
          invoice_number: cmd.invoice_number || null,
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async dispatch(actor, cmd) {
    this.requireRole(actor, Role.WAREHOUSE, Role.FINANCE);
    const state = this.state();
    const supply = state.supplies.get(cmd.supply_id);
    if (!supply) throw new Error(`供应单不存在：${cmd.supply_id}`);
    if (supply.dispatch) throw new Error(`供应单 ${cmd.supply_id} 已出库`);
    return this.#publish([
      this.#envelope({
        type: EventType.SUPPLY_DISPATCHED,
        aggregateType: AggregateType.SUPPLY,
        aggregateId: cmd.supply_id,
        occurredAt: cmd.occurred_at,
        summary: `出库 ${cmd.supply_id}`,
        payload: {
          supply_id: cmd.supply_id,
          lot_id: supply.lot_id,
          dispatched_at: cmd.dispatched_at,
          quantity: cmd.quantity,
          unit: cmd.unit,
          warehouse_event_id: cmd.warehouse_event_id || null,
        },
        causationId: cmd.warehouse_event_id,
        source: "warehouse",
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  // ---------- 计税 ----------
  // 返回 { events, determination }；当无有效签署时：证据完整且唯一候选可系统确认，
  // 边界或证据不足一律拒绝并附候选与缺失证据清单。
  async calculateForSupply(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    const supply = state.supplies.get(cmd.supply_id);
    if (!supply) throw new Error(`供应单不存在：${cmd.supply_id}`);
    const live = liveInitialEntries(state, cmd.supply_id);
    if (live.length) {
      const err = new Error(`供应单 ${cmd.supply_id} 已有有效计税分录 ${live[0].entry_id}；事实变化须先冲正再补充，不得覆盖`);
      err.code = "ENTRY_ALREADY_LIVE";
      throw err;
    }
    const profile = state.profiles.get(supply.profile_id);
    const invoice = supply.invoices.length
      ? state.invoices.get(supply.invoices[supply.invoices.length - 1])
      : null;

    // 先构建分类签署事件（如需系统确认），再构建计税事件，最后一次性发布。
    const events = [];
    const signing = this.#ensureSigning({ profile, actor, cmd, events });

    const result = calculateTax({
      ruleRegistry: state.rules,
      ruleCode: cmd.rule_code || this.defaultRuleCode,
      category: signing.category,
      profile,
      evidence: state.evidence.get(supply.profile_id) || [],
      contract: supply.contract,
      invoice,
      dispatch: supply.dispatch,
      quantity: cmd.quantity ?? supply.dispatch?.quantity ?? supply.contract.quantity,
      classification: signing,
    });
    if (!result.ok) throw new Error(result.error);

    const entryId = cmd.entry_id || `entry-${randomUUID()}`;
    events.push(
      this.#envelope({
        type: EventType.TAX_CALCULATED,
        aggregateType: AggregateType.ENTRY,
        aggregateId: entryId,
        occurredAt: cmd.occurred_at,
        summary: `${result.exempt ? "免税" : `应纳消费税 ${result.tax_amount}`}：${supply.lot_id} / ${signing.category}`,
        payload: {
          entry_id: entryId,
          supply_id: cmd.supply_id,
          lot_id: supply.lot_id,
          profile_id: supply.profile_id,
          taxable_event: result.taxable_event,
          taxable_event_at: result.taxable_event_at,
          rule_code: result.rule.rule_code,
          rule_version: result.rule.rule_version,
          category: signing.category,
          rate: result.rate,
          exempt: result.exempt,
          tax_basis_price: result.tax_basis_price,
          currency: result.currency,
          quantity: result.quantity,
          tax_amount: result.tax_amount,
          explanation: result.explanation,
        },
        idempotencyKey: cmd.idempotency_key,
      })
    );
    const published = await this.#publish(events);
    return { events: published, determination: { ...result, entry_id: entryId, signing } };
  }

  // 构建（不发布）必要的分类签署事件：已有有效签署则复用；
  // 无签署时，证据完整且候选唯一可由系统确认；边界或证据不足一律拒绝并附候选与缺失证据。
  #ensureSigning({ profile, actor, cmd, events }) {
    const asOf = cmd.as_of || cmd.occurred_at || this.nowIso();
    const state = this.state();
    const current = [...(state.signings.get(profile.profile_id) || [])]
      .filter((s) => Date.parse(s.valid_from) <= Date.parse(asOf))
      .filter((s) => !s.valid_until || Date.parse(s.valid_until) > Date.parse(asOf))
      .sort((a, b) => Date.parse(b.signed_at) - Date.parse(a.signed_at))[0];
    if (current) return current;

    const proposal = this.proposeClassification(actor, { profile_id: profile.profile_id, as_of: asOf, rule_code: cmd.rule_code });
    if (proposal.boundary) {
      const err = new Error("边界产品或证据不足，必须由授权税务人员签署后才能计税");
      err.code = "BOUNDARY_SIGNATURE_REQUIRED";
      err.proposal = proposal;
      throw err;
    }
    if (proposal.candidates.length !== 1 || proposal.candidates[0].confidence !== "verified") {
      const err = new Error("无法自动确认分类：候选不唯一或证据不完整");
      err.code = "CLASSIFICATION_UNVERIFIED";
      err.proposal = proposal;
      throw err;
    }
    const chosen = proposal.candidates[0];
    const evidenceRefs = [...new Set((state.evidence.get(profile.profile_id) || []).map((e) => e.evidence_ref))];
    const signedAt = asOf;
    events.push(
      this.#envelope({
        type: EventType.CLASSIFICATION_SIGNED,
        aggregateType: AggregateType.CLASSIFICATION,
        aggregateId: `classification:${profile.profile_id}`,
        occurredAt: cmd.occurred_at || signedAt,
        summary: `系统确认唯一且证据完整的分类：${chosen.category}`,
        payload: {
          profile_id: profile.profile_id,
          category: chosen.category,
          signer: "system",
          signer_role: "system_verified",
          signed_at: signedAt,
          evidence_refs: evidenceRefs,
          boundary: false,
          valid_from: signedAt.slice(0, 10),
          valid_until: null,
          note: "非边界产品、候选唯一且检验证据齐备，系统自动确认；市场名称不参与判定。",
        },
      })
    );
    return {
      category: chosen.category,
      signed_at: signedAt,
      signer: "system",
      signer_role: "system_verified",
      boundary: false,
      evidence_refs: evidenceRefs,
      valid_from: signedAt.slice(0, 10),
      valid_until: null,
    };
  }

  // ---------- 更正：冲正与补充 ----------
  // 退货/折让：对仍有效的原分录做反方向冲正（支持部分冲正）；原分录与原申报永不修改。
  async reverseEntry(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    const original = state.entries.get(cmd.entry_id);
    if (!original) throw new Error(`原分录不存在：${cmd.entry_id}`);
    if (original.kind !== "initial") throw new Error("只能冲正初始计税分录");
    if (!["return", "allowance", "usage_change", "review"].includes(cmd.reason_code))
      throw new Error("reason_code 必须为 return | allowance | usage_change | review");

    const remaining = original.tax_amount + sumReversals(state, original.entry_id);
    let amount;
    if (cmd.tax_amount !== undefined) {
      amount = cmd.tax_amount;
      if (amount > 0) throw new Error("冲正税额必须为负数或零");
      if (-amount > Math.abs(remaining) + 1e-9) throw new Error(`冲正超额：剩余未冲正 ${remaining}`);
    } else {
      amount = -Math.abs(remaining);
    }

    const entryId = cmd.reversal_id || `rev-${randomUUID()}`;
    const event = this.#envelope({
      type: EventType.ENTRY_REVERSED,
      aggregateType: AggregateType.ENTRY,
      aggregateId: entryId,
      occurredAt: cmd.occurred_at,
      summary: `冲正分录 ${cmd.entry_id}（${cmd.reason_code}）金额 ${amount}`,
      payload: {
        entry_id: entryId,
        reverses_entry_id: cmd.entry_id,
        supply_id: original.supply_id,
        lot_id: original.lot_id,
        reason_code: cmd.reason_code,
        reason_ref: cmd.reason_ref || null,
        reversed_at: cmd.reversed_at || cmd.occurred_at || this.nowIso(),
        tax_amount: round2(amount),
        quantity: cmd.quantity ?? null,
        explanation: {
          type: "reversal",
          original_entry_id: cmd.entry_id,
          original_tax_amount: original.tax_amount,
          remaining_before: round2(remaining),
          reversal_amount: round2(amount),
          reason_code: cmd.reason_code,
          reason_ref: cmd.reason_ref || null,
          note: "冲正不删除、不覆盖原分录与原申报；退货再销售应另行开具补充分录。",
        },
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  // 补充分录：退货后再销售、用途变化转入应税、复核补税等。
  async addSupplement(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    const profile = state.profiles.get(cmd.profile_id);
    if (!profile) throw new Error(`产品档案不存在：${cmd.profile_id}`);
    const signings = (state.signings.get(cmd.profile_id) || [])
      .filter((s) => Date.parse(s.valid_from) <= Date.parse(cmd.taxable_event_at))
      .filter((s) => !s.valid_until || Date.parse(s.valid_until) > Date.parse(cmd.taxable_event_at));
    if (!signings.length) {
      const err = new Error("补充分录需要有效的分类签署");
      err.code = "BOUNDARY_SIGNATURE_REQUIRED";
      throw err;
    }
    const signing = [...signings].sort((a, b) => Date.parse(b.signed_at) - Date.parse(a.signed_at))[0];
    const result = calculateTax({
      ruleRegistry: state.rules,
      ruleCode: cmd.rule_code || this.defaultRuleCode,
      category: signing.category,
      profile,
      evidence: state.evidence.get(cmd.profile_id) || [],
      contract: cmd.contract || null,
      invoice: cmd.invoice || null,
      dispatch: cmd.dispatch || null,
      usageChange: cmd.usage_change || null,
      quantity: cmd.quantity,
      classification: signing,
    });
    if (!result.ok) throw new Error(result.error);

    const entryId = cmd.entry_id || `sup-${randomUUID()}`;
    const event = this.#envelope({
      type: EventType.ENTRY_ADDED,
      aggregateType: AggregateType.ENTRY,
      aggregateId: entryId,
      occurredAt: cmd.occurred_at,
      summary: `补充分录（${cmd.reason_code}）：${cmd.lot_id} 税额 ${result.tax_amount}`,
      payload: {
        entry_id: entryId,
        supplements_entry_id: cmd.supplements_entry_id || null,
        supply_id: cmd.supply_id || null,
        lot_id: cmd.lot_id,
        profile_id: cmd.profile_id,
        reason_code: cmd.reason_code,
        taxable_event_at: result.taxable_event_at,
        rule_code: result.rule.rule_code,
        rule_version: result.rule.rule_version,
        category: signing.category,
        rate: result.rate,
        exempt: result.exempt,
        tax_basis_price: result.tax_basis_price,
        currency: result.currency,
        quantity: result.quantity,
        tax_amount: result.tax_amount,
        explanation: result.explanation,
      },
      idempotencyKey: cmd.idempotency_key,
    });
    return this.#publish([event]);
  }

  async recordReview(actor, cmd) {
    this.requireRole(actor, Role.TAX_OFFICER);
    const state = this.state();
    for (const id of cmd.entry_ids) if (!state.entries.has(id)) throw new Error(`分录不存在：${id}`);
    const reviewId = cmd.review_id || `review-${randomUUID()}`;
    return this.#publish([
      this.#envelope({
        type: EventType.TAX_REVIEWED,
        aggregateType: AggregateType.ENTRY,
        aggregateId: `review:${reviewId}`,
        occurredAt: cmd.occurred_at,
        summary: `税务复核结论：${cmd.conclusion}`,
        payload: {
          review_id: reviewId,
          entry_ids: cmd.entry_ids,
          reviewer: actor.id,
          reviewed_at: cmd.reviewed_at || cmd.occurred_at || this.nowIso(),
          conclusion: cmd.conclusion,
          note: cmd.note || null,
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  // ---------- 申报 ----------
  async submitFiling(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    if (state.filings.has(cmd.filing_id)) throw new Error(`申报批次已存在：${cmd.filing_id}`);
    const check = validateFiling(state, cmd);
    if (!check.ok) {
      const err = new Error(`申报校验失败：${check.errors.join("；")}`);
      err.code = "FILING_INVALID";
      err.errors = check.errors;
      throw err;
    }
    if (cmd.total_tax_amount !== undefined && Math.abs(cmd.total_tax_amount - check.computed_total) > 0.01) {
      const err = new Error(`申报合计 ${cmd.total_tax_amount} 与分录合计 ${check.computed_total} 不一致`);
      err.code = "FILING_TOTAL_MISMATCH";
      throw err;
    }
    return this.#publish([
      this.#envelope({
        type: EventType.FILING_SUBMITTED,
        aggregateType: AggregateType.FILING,
        aggregateId: cmd.filing_id,
        occurredAt: cmd.occurred_at,
        summary: `申报批次 ${cmd.filing_id}（${cmd.period_start} ~ ${cmd.period_end}）提交并锁定`,
        payload: {
          filing_id: cmd.filing_id,
          period_start: cmd.period_start,
          period_end: cmd.period_end,
          submitted_at: cmd.submitted_at || cmd.occurred_at || this.nowIso(),
          entry_ids: [...new Set(cmd.entry_ids)],
          total_tax_amount: check.computed_total,
          currency: cmd.currency || check.currency || "CNY",
        },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }

  async settleFiling(actor, cmd) {
    this.requireRole(actor, Role.FINANCE, Role.TAX_OFFICER);
    const state = this.state();
    if (!state.filings.has(cmd.filing_id)) throw new Error(`申报批次不存在：${cmd.filing_id}`);
    return this.#publish([
      this.#envelope({
        type: EventType.FILING_SETTLED,
        aggregateType: AggregateType.FILING,
        aggregateId: cmd.filing_id,
        occurredAt: cmd.occurred_at,
        summary: `申报批次 ${cmd.filing_id} 缴款入库`,
        payload: { filing_id: cmd.filing_id, settled_at: cmd.settled_at, reference: cmd.reference || null },
        idempotencyKey: cmd.idempotency_key,
      }),
    ]);
  }
}

function sumReversals(state, entryId) {
  let sum = 0;
  for (const e of state.entries.values()) {
    if (e.kind === "reversal" && e.reverses === entryId) sum += e.tax_amount;
  }
  return round2(sum);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

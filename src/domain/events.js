// 领域事件目录：事件类型、聚合类型、各事件 payload 字段约定与校验。
// 信封（event_id/event_type/aggregate_type/aggregate_id/occurred_at/version/summary）
// 的含义见 contracts/domain.schema.json，本模块是 payload 形状的权威定义。

export const EventType = Object.freeze({
  // 法规版本
  RULE_EFFECTIVE: "RULE_EFFECTIVE",
  // 产品技术档案与市场名称
  PROFILE_REGISTERED: "PROFILE_REGISTERED",
  PROFILE_RENAMED: "PROFILE_RENAMED",
  // 证据与分类
  EVIDENCE_ATTACHED: "EVIDENCE_ATTACHED",
  CLASSIFICATION_PROPOSED: "CLASSIFICATION_PROPOSED",
  CLASSIFICATION_SIGNED: "CLASSIFICATION_SIGNED",
  // 生产批次与组成
  LOT_RECORDED: "LOT_RECORDED",
  LOT_COMPLETED: "LOT_COMPLETED",
  LOT_BOM_LINKED: "LOT_BOM_LINKED",
  LOT_USAGE_CHANGED: "LOT_USAGE_CHANGED",
  // 应税业务时点
  SUPPLY_CONTRACTED: "SUPPLY_CONTRACTED",
  INVOICE_ISSUED: "INVOICE_ISSUED",
  SUPPLY_DISPATCHED: "SUPPLY_DISPATCHED",
  // 计税与凭证
  TAX_CALCULATED: "TAX_CALCULATED",
  ENTRY_REVERSED: "ENTRY_REVERSED",
  ENTRY_ADDED: "ENTRY_ADDED",
  TAX_REVIEWED: "TAX_REVIEWED",
  // 申报
  FILING_SUBMITTED: "FILING_SUBMITTED",
  FILING_SETTLED: "FILING_SETTLED",
  // 兼容历史事件
  LOT_CLASSIFIED: "LOT_CLASSIFIED",
  ENTRY_ADJUSTED: "ENTRY_ADJUSTED",
});

export const AggregateType = Object.freeze({
  TAX_RULE: "tax_rule",
  PRODUCT_PROFILE: "product_profile",
  CLASSIFICATION: "battery_classification",
  LOT: "production_lot",
  SUPPLY: "taxable_supply",
  INVOICE: "invoice",
  ENTRY: "tax_entry",
  FILING: "tax_filing",
});

// 字段类型：string/number/integer/boolean/array/object；标有 required 的为必填。
// 深层结构（如 attributes）的业务合法性在领域模型内判定，这里只做形状层校验。
const catalog = {
  [EventType.RULE_EFFECTIVE]: {
    aggregate: AggregateType.TAX_RULE,
    fields: {
      rule_code: { type: "string", required: true },
      rule_version: { type: "integer", required: true },
      title: { type: "string", required: true },
      legal_basis: { type: "string", required: true },
      effective_start: { type: "string", required: true }, // 当地日历日 YYYY-MM-DD
      effective_end: { type: "string" }, // null/缺省视为开放区间
      time_zone: { type: "string", required: true }, // IANA，例如 Asia/Shanghai
      // 各税目的税率阶梯与免税窗口；结构见 taxation.js
      categories: { type: "array", required: true },
      replaces_version: { type: "integer" },
      timing_policy: { type: "string" }, // cn_goods_default（缺省）等应税时点政策标识
      rounding: { type: "object" }, // { decimals: 2, mode: "half_up" }
    },
  },
  [EventType.PROFILE_REGISTERED]: {
    aggregate: AggregateType.PRODUCT_PROFILE,
    fields: {
      profile_id: { type: "string", required: true },
      market_name: { type: "string", required: true },
      declared_form: { type: "string", required: true }, // cell | module | pack | system
      prior_names: { type: "array" },
      attributes: { type: "object", required: true }, // 可核验技术属性
      supplier_id: { type: "string" },
    },
  },
  [EventType.PROFILE_RENAMED]: {
    aggregate: AggregateType.PRODUCT_PROFILE,
    fields: {
      profile_id: { type: "string", required: true },
      old_name: { type: "string", required: true },
      new_name: { type: "string", required: true },
      renamed_at: { type: "string", required: true },
      reason: { type: "string" },
    },
  },
  [EventType.EVIDENCE_ATTACHED]: {
    aggregate: AggregateType.CLASSIFICATION,
    fields: {
      profile_id: { type: "string", required: true },
      evidence_type: { type: "string", required: true }, // test_report | composition_bom | process_spec | datasheet | pilot_qualification | other
      evidence_ref: { type: "string", required: true }, // 报告编号/URI
      issuer: { type: "string", required: true },
      issued_at: { type: "string", required: true },
      attributes_verified: { type: "array", required: true }, // 本证据核验了哪些技术属性键
      valid_until: { type: "string" },
    },
  },
  [EventType.CLASSIFICATION_PROPOSED]: {
    aggregate: AggregateType.CLASSIFICATION,
    fields: {
      profile_id: { type: "string", required: true },
      candidate_categories: { type: "array", required: true }, // [{category, confidence, reasons[]}]
      missing_evidence: { type: "array", required: true }, // 缺失属性/证据说明
      boundary: { type: "boolean", required: true },
      proposed_by: { type: "string", required: true }, // 系统或人员
    },
  },
  [EventType.CLASSIFICATION_SIGNED]: {
    aggregate: AggregateType.CLASSIFICATION,
    fields: {
      profile_id: { type: "string", required: true },
      category: { type: "string", required: true },
      signer: { type: "string", required: true },
      signer_role: { type: "string", required: true },
      signed_at: { type: "string", required: true },
      evidence_refs: { type: "array", required: true },
      boundary: { type: "boolean", required: true },
      valid_from: { type: "string", required: true },
      valid_until: { type: "string" },
      note: { type: "string" },
    },
  },
  [EventType.LOT_RECORDED]: {
    aggregate: AggregateType.LOT,
    fields: {
      lot_id: { type: "string", required: true },
      profile_id: { type: "string", required: true },
      produced_at: { type: "string", required: true },
      quantity: { type: "number", required: true },
      unit: { type: "string", required: true },
      plant_id: { type: "string" },
    },
  },
  [EventType.LOT_COMPLETED]: {
    aggregate: AggregateType.LOT,
    fields: {
      lot_id: { type: "string", required: true },
      completed_at: { type: "string", required: true },
      inspection_ref: { type: "string" },
    },
  },
  [EventType.LOT_BOM_LINKED]: {
    aggregate: AggregateType.LOT,
    fields: {
      lot_id: { type: "string", required: true },
      parent_lot_id: { type: "string" }, // 该批次作为物料被哪个上层批次/模组耗用
      module_lot_id: { type: "string" },
      quantity_consumed: { type: "number", required: true },
      unit: { type: "string", required: true },
    },
  },
  [EventType.LOT_USAGE_CHANGED]: {
    aggregate: AggregateType.LOT,
    fields: {
      lot_id: { type: "string", required: true },
      old_usage: { type: "string", required: true },
      new_usage: { type: "string", required: true }, // sale | self_use | r_d_sample | writeoff
      changed_at: { type: "string", required: true },
      reason: { type: "string" },
    },
  },
  [EventType.SUPPLY_CONTRACTED]: {
    aggregate: AggregateType.SUPPLY,
    fields: {
      supply_id: { type: "string", required: true },
      lot_id: { type: "string", required: true },
      profile_id: { type: "string", required: true },
      counterparty: { type: "string", required: true },
      contracted_at: { type: "string", required: true },
      contracted_price: { type: "number", required: true },
      currency: { type: "string", required: true },
      quantity: { type: "number", required: true },
      unit: { type: "string", required: true },
      settlement_terms: { type: "string" }, // prepayment | on_credit | installment
      payment_due_at: { type: "string" }, // 赊销/分期收款合同约定收款日（应税时点候选）
      payment_received_at: { type: "string" } // 直接收款实际收款日
    },
  },
  [EventType.INVOICE_ISSUED]: {
    aggregate: AggregateType.INVOICE,
    fields: {
      invoice_id: { type: "string", required: true },
      supply_id: { type: "string", required: true },
      issued_at: { type: "string", required: true },
      invoice_price: { type: "number", required: true },
      currency: { type: "string", required: true },
      invoice_number: { type: "string" },
    },
  },
  [EventType.SUPPLY_DISPATCHED]: {
    aggregate: AggregateType.SUPPLY,
    fields: {
      supply_id: { type: "string", required: true },
      lot_id: { type: "string", required: true },
      dispatched_at: { type: "string", required: true },
      quantity: { type: "number", required: true },
      unit: { type: "string", required: true },
      warehouse_event_id: { type: "string" }, // 沿用仓库领域事件标识
    },
  },
  [EventType.TAX_CALCULATED]: {
    aggregate: AggregateType.ENTRY,
    fields: {
      entry_id: { type: "string", required: true },
      supply_id: { type: "string" },
      lot_id: { type: "string", required: true },
      profile_id: { type: "string", required: true },
      taxable_event: { type: "string", required: true }, // contract | invoice | dispatch | usage_change
      taxable_event_at: { type: "string", required: true },
      rule_code: { type: "string", required: true },
      rule_version: { type: "integer", required: true },
      category: { type: "string", required: true },
      rate: { type: "number", required: true }, // 小数，0.04 表示 4%；0 表示免税
      exempt: { type: "boolean", required: true },
      tax_basis_price: { type: "number", required: true },
      currency: { type: "string", required: true },
      quantity: { type: "number", required: true },
      tax_amount: { type: "number", required: true },
      explanation: { type: "object", required: true }, // 可重放的判定解释
    },
  },
  [EventType.ENTRY_REVERSED]: {
    aggregate: AggregateType.ENTRY,
    fields: {
      entry_id: { type: "string", required: true }, // 新分录 id
      reverses_entry_id: { type: "string", required: true }, // 被冲正的原分录
      supply_id: { type: "string" },
      lot_id: { type: "string", required: true },
      reason_code: { type: "string", required: true }, // return | allowance | usage_change | review
      reason_ref: { type: "string" },
      reversed_at: { type: "string", required: true },
      tax_amount: { type: "number", required: true }, // 与原分录相反符号
      quantity: { type: "number" },
      explanation: { type: "object", required: true },
    },
  },
  [EventType.ENTRY_ADDED]: {
    aggregate: AggregateType.ENTRY,
    fields: {
      entry_id: { type: "string", required: true },
      supplements_entry_id: { type: "string" }, // 补充分录所关联的原分录
      supply_id: { type: "string" },
      lot_id: { type: "string", required: true },
      profile_id: { type: "string", required: true },
      reason_code: { type: "string", required: true }, // return_resale | usage_change | review | correction
      taxable_event_at: { type: "string", required: true },
      rule_code: { type: "string", required: true },
      rule_version: { type: "integer", required: true },
      category: { type: "string", required: true },
      rate: { type: "number", required: true },
      exempt: { type: "boolean", required: true },
      tax_basis_price: { type: "number", required: true },
      currency: { type: "string", required: true },
      quantity: { type: "number", required: true },
      tax_amount: { type: "number", required: true },
      explanation: { type: "object", required: true },
    },
  },
  [EventType.TAX_REVIEWED]: {
    aggregate: AggregateType.ENTRY,
    fields: {
      review_id: { type: "string", required: true },
      entry_ids: { type: "array", required: true },
      reviewer: { type: "string", required: true },
      reviewed_at: { type: "string", required: true },
      conclusion: { type: "string", required: true }, // confirmed | reversed | supplemented
      note: { type: "string" },
    },
  },
  [EventType.FILING_SUBMITTED]: {
    aggregate: AggregateType.FILING,
    fields: {
      filing_id: { type: "string", required: true },
      period_start: { type: "string", required: true },
      period_end: { type: "string", required: true },
      submitted_at: { type: "string", required: true },
      entry_ids: { type: "array", required: true },
      total_tax_amount: { type: "number", required: true },
      currency: { type: "string", required: true },
    },
  },
  [EventType.FILING_SETTLED]: {
    aggregate: AggregateType.FILING,
    fields: {
      filing_id: { type: "string", required: true },
      settled_at: { type: "string", required: true },
      reference: { type: "string" },
    },
  },
  [EventType.LOT_CLASSIFIED]: {
    // 历史保留事件：新业务请使用 CLASSIFICATION_PROPOSED / CLASSIFICATION_SIGNED
    aggregate: AggregateType.CLASSIFICATION,
    fields: {},
  },
  [EventType.ENTRY_ADJUSTED]: {
    // 历史保留事件：新业务请使用 ENTRY_REVERSED / ENTRY_ADDED 表达冲正与补充
    aggregate: AggregateType.TAX_RULE,
    fields: {},
  },
};

export function eventSpec(eventType) {
  return catalog[eventType] || null;
}

const envelopeRequired = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

function checkValue(value, spec, path, errors) {
  if (value === undefined || value === null) return;
  if (spec.type === "array" && !Array.isArray(value)) errors.push(`${path} 必须是数组`);
  if (spec.type === "object" && (typeof value !== "object" || Array.isArray(value)))
    errors.push(`${path} 必须是对象`);
  if (spec.type === "string" && typeof value !== "string") errors.push(`${path} 必须是字符串`);
  if (spec.type === "number" && typeof value !== "number") errors.push(`${path} 必须是数字`);
  if (spec.type === "integer" && (!Number.isInteger(value))) errors.push(`${path} 必须是整数`);
  if (spec.type === "boolean" && typeof value !== "boolean") errors.push(`${path} 必须是布尔值`);
}

// 与历史版本兼容的信封校验；对已登记事件附加 payload 形状校验。
export function validateEvent(record) {
  const errors = envelopeRequired
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1))
    errors.push("version 必须是正整数");

  if ("occurred_at" in record && !isValidDateTime(record.occurred_at))
    errors.push("occurred_at 必须是带偏移的日期时间（RFC3339）");

  const spec = record.event_type && catalog[record.event_type];
  if (!spec) {
    errors.push(`未登记的事件类型：${record.event_type}`);
    return errors;
  }
  if (record.aggregate_type && spec.aggregate !== record.aggregate_type)
    errors.push(
      `事件 ${record.event_type} 的聚合应为 ${spec.aggregate}，实际为 ${record.aggregate_type}`
    );

  const payload = record.payload || {};
  for (const [name, field] of Object.entries(spec.fields)) {
    const value = payload[name];
    const present = value !== undefined && value !== null;
    if (field.required && !present) {
      errors.push(`payload 缺少字段：${name}`);
      continue;
    }
    if (present) checkValue(value, field, `payload.${name}`, errors);
  }
  return errors;
}

export function isValidDateTime(value) {
  if (typeof value !== "string") return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // RFC3339 必须带时区：Z 或 ±HH:MM，防止"裸"本地时间被静默按主机时区解释
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(value);
}

export const EVENT_TYPES = Object.freeze(Object.keys(catalog));

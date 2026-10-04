// 领域事件基础校验：信封字段 + 各事件类型必须满足的不变量。
// 校验只负责“形状与硬约束”，分类与计税的业务判定在 src/domain/* 中。

export const EVENT_TYPES = [
  "RULE_VERSION_PUBLISHED",
  "RULE_EFFECTIVE",
  "RULE_REPEALED",
  "TECHNICAL_PROFILE_REGISTERED",
  "EVIDENCE_SUBMITTED",
  "CLASSIFICATION_PROPOSED",
  "CLASSIFICATION_SIGNED",
  "PRODUCTION_LOT_RECORDED",
  "COMPONENT_CONSUMED",
  "STOCK_INBOUND",
  "STOCK_OUTBOUND",
  "STOCK_RETURNED",
  "CONTRACT_SIGNED",
  "TAX_POINT_DETERMINED",
  "INVOICE_ISSUED",
  "INVOICE_RED_ISSUED",
  "TAX_CALCULATED",
  "FILING_SUBMITTED",
  "ENTRY_POSTED",
  "ENTRY_ADJUSTED",
];

export const AGGREGATE_TYPES = [
  "tax_rule",
  "technical_profile",
  "evidence_bundle",
  "battery_classification",
  "production_lot",
  "warehouse_inventory",
  "sales_contract",
  "tax_point",
  "invoice",
  "tax_assessment",
  "accounting_entry",
  "tax_filing",
];

// 有权对边界产品签署分类结论的角色；市场名称不在授权依据之列。
export const AUTHORIZED_SIGNER_ROLES = new Set([
  "authorized_classification_officer",
  "tax_director",
]);

export const EVIDENCE_TYPES = new Set([
  "inspection_report", // 第三方检验报告（电化学体系、固态电解质占比等）
  "bom_composition", // 组成物料清单
  "safety_cert", // 安全认证
  "process_record", // 生产过程记录
  "upstream_tax_voucher", // 上游已纳消费税凭证（模组抵扣用）
]);

export const ADJUSTMENT_TYPES = new Set(["reversal", "supplement"]);
export const ADJUSTMENT_REASONS = new Set([
  "return", // 退货
  "allowance", // 折让
  "use_change", // 用途变化
  "review_reclass", // 税务复核导致的分类变化
  "price_correction", // 价格更正
]);

const REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const AGGREGATE_TYPE_SET = new Set(AGGREGATE_TYPES);

// 必须携带时区偏移量，否则跨生效日比较会歧义。
function parseOffsetDateTime(value) {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return null;
  return t;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function checkPublishedRule(payload, errors) {
  for (const k of [
    "rule_id",
    "rule_version_no",
    "citation",
    "tax_scope",
    "effective_from",
    "published_at",
  ]) {
    if (!isNonEmptyString(String(payload[k] ?? ""))) errors.push(`RULE_VERSION_PUBLISHED 缺少字段：${k}`);
  }
  if (typeof payload.rate !== "number" || payload.rate < 0 || payload.rate > 1) {
    errors.push("rate 必须是 0 到 1 之间的小数（从价税率）");
  }
  if (typeof payload.is_exempt !== "boolean") errors.push("is_exempt 必须是布尔值");
  const from = parseOffsetDateTime(payload.effective_from);
  if (from === null) errors.push("effective_from 必须是带时区的时间");
  if (payload.effective_to != null) {
    const to = parseOffsetDateTime(payload.effective_to);
    if (to === null) errors.push("effective_to 必须是带时区的时间或 null");
    if (from !== null && to !== null && to <= from) errors.push("生效区间必须满足 effective_from < effective_to（左闭右开）");
  }
  if (parseOffsetDateTime(payload.published_at) === null) errors.push("published_at 必须是带时区的时间");
}

function checkEvidence(payload, errors) {
  if (!isNonEmptyString(payload.profile_id)) errors.push("EVIDENCE_SUBMITTED 缺少 profile_id");
  if (!EVIDENCE_TYPES.has(payload.evidence_type)) errors.push(`未知证据类型：${payload.evidence_type}`);
  if (!isNonEmptyString(payload.document_ref)) errors.push("证据缺少 document_ref");
  if (payload.verified !== true) errors.push("证据必须经核验（verified=true）后方可用于判定");
}

function checkSigned(payload, errors) {
  for (const k of ["profile_id", "decided_category", "signer_id", "signed_at"]) {
    if (!isNonEmptyString(String(payload[k] ?? ""))) errors.push(`CLASSIFICATION_SIGNED 缺少字段：${k}`);
  }
  if (!AUTHORIZED_SIGNER_ROLES.has(payload.signer_role)) {
    errors.push(`签署角色未授权：${payload.signer_role}`);
  }
  if (!Array.isArray(payload.evidence_ids) || payload.evidence_ids.length === 0) {
    errors.push("边界分类签署必须引用至少一份已核验证据");
  }
  if (parseOffsetDateTime(payload.signed_at) === null) errors.push("signed_at 必须是带时区的时间");
}

function checkTaxCalculated(payload, errors) {
  for (const k of ["assessment_id", "lot_id", "tax_point_id", "profile_id", "taxable_price", "rate", "tax_amount"]) {
    if (!(k in payload)) errors.push(`TAX_CALCULATED 缺少字段：${k}`);
  }
  if (typeof payload.tax_amount !== "number" || payload.tax_amount < 0) errors.push("tax_amount 必须是非负数字");
  if (!payload.explanation || typeof payload.explanation !== "object") errors.push("计税事件必须内嵌 explanation 解释对象");
}

function checkAdjustment(payload, errors) {
  if (!ADJUSTMENT_TYPES.has(payload.adjustment_type)) errors.push(`adjustment_type 必须是 reversal 或 supplement：${payload.adjustment_type}`);
  if (!ADJUSTMENT_REASONS.has(payload.reason_code)) errors.push(`未知更正原因：${payload.reason_code}`);
  if (!isNonEmptyString(payload.original_entry_id)) errors.push("更正分录必须引用 original_entry_id，不得覆盖原分录");
  if (!isNonEmptyString(payload.filing_id)) errors.push("更正必须归属一个申报批次（通常是后续期间）");
  if (typeof payload.amount !== "number") errors.push("更正分录 amount 必须是带符号金额");
}

function checkFiling(payload, errors) {
  if (!isNonEmptyString(payload.period)) errors.push("FILING_SUBMITTED 缺少 period");
  const hasAssessments = Array.isArray(payload.assessment_ids) && payload.assessment_ids.length > 0;
  const hasAdjustments = Array.isArray(payload.adjustment_entry_ids) && payload.adjustment_entry_ids.length > 0;
  if (!hasAssessments && !hasAdjustments) {
    errors.push("申报批次必须包含计税结论或更正分录（更正-only 期间允许为空 assessment_ids）");
  }
  if (payload.assessment_ids != null && !Array.isArray(payload.assessment_ids)) errors.push("assessment_ids 必须是数组");
  if (parseOffsetDateTime(payload.submitted_at) === null) errors.push("submitted_at 必须是带时区的时间");
}

export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if (EVENT_TYPE_SET.has(record.event_type) === false) errors.push(`未知事件类型：${record.event_type}`);
  if (AGGREGATE_TYPE_SET.has(record.aggregate_type) === false) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (parseOffsetDateTime(record.occurred_at) === null) errors.push("occurred_at 必须是带时区偏移的时间");
  if (!isNonEmptyString(record.summary)) errors.push("summary 不能为空");

  const p = record.payload;
  if (p && typeof p === "object") {
    switch (record.event_type) {
      case "RULE_VERSION_PUBLISHED":
        checkPublishedRule(p, errors);
        break;
      case "EVIDENCE_SUBMITTED":
        checkEvidence(p, errors);
        break;
      case "CLASSIFICATION_SIGNED":
        checkSigned(p, errors);
        break;
      case "TAX_CALCULATED":
        checkTaxCalculated(p, errors);
        break;
      case "FILING_SUBMITTED":
        checkFiling(p, errors);
        break;
      case "ENTRY_ADJUSTED":
        checkAdjustment(p, errors);
        break;
      default:
        break;
    }
  }
  return errors;
}

// 判定应用服务：给定事件日志与一个销售行请求，重放全部事实后输出
// TAX_POINT_DETERMINED 与（可计税时）TAX_CALCULATED 事件；不满足条件时返回缺失证据/阻断原因。
// 这是“列出缺失证据和候选分类、边界产品拒绝自动认定”的对外入口。

import { EventStore } from "./domain/store.js";
import { projectRules } from "./domain/rules.js";
import { projectClassifications, evaluateProfile } from "./domain/classification.js";
import { projectOperations } from "./domain/operations.js";
import { determineTaxPoint } from "./domain/taxpoint.js";
import { calculateTax } from "./domain/assessment.js";
import { event } from "./factory.js";

export class DeterminationService {
  constructor(store) {
    this.store = store ?? new EventStore();
  }

  projections(asOfMs = Infinity) {
    const events = this.store.replay({ asOfMs });
    return {
      rules: projectRules(events),
      classifications: projectClassifications(events),
      operations: projectOperations(events),
    };
  }

  // 返回 {taxPointEvent, assessmentEvent? , result}
  determine({
    taxPointId,
    assessmentId,
    lotId,
    contractId,
    invoiceId,
    paymentReceivedAt,
    quantity,
    unitPriceExVat,
    currency = "CNY",
    correlationId,
    asOfMs = Infinity,
    creditInputs = [],
    now,
  }) {
    const { rules, classifications, operations } = this.projections(asOfMs);
    const lot = operations.lots.get(lotId);
    if (!lot) throw new Error(`生产批次不存在：${lotId}`);
    const profile = classifications.profiles.get(lot.profile_id);
    if (!profile) throw new Error(`批次 ${lotId} 缺少技术档案：${lot.profile_id}`);

    const contract = contractId ? operations.contracts.get(contractId) : null;
    const invoice = invoiceId ? operations.invoices.get(invoiceId) : null;
    const line = contract?.lines?.find((l) => l.lot_id === lotId) ?? null;

    const tp = determineTaxPoint({ contract, lot, line, invoice, paymentReceivedAt });

    const taxPointEvent = event({
      type: "TAX_POINT_DETERMINED",
      aggregateType: "tax_point",
      aggregateId: taxPointId,
      occurredAt: now ?? new Date().toISOString(),
      payload: {
        lot_id: lotId,
        contract_id: contractId ?? null,
        invoice_id: invoiceId ?? null,
        tax_point_at: tp.tax_point_ms ? new Date(tp.tax_point_ms).toISOString() : null,
        basis: tp.basis,
        facts: tp.facts,
      },
      summary: `应税时点：${tp.basis}`,
      correlationId,
    });

    const evaluation = evaluateProfile(classifications, lot.profile_id, { asOfMs });
    const result = calculateTax({
      classification: evaluation,
      rulesState: rules,
      taxPoint: tp,
      priceInput: { quantity, unit_price_ex_vat: unitPriceExVat, currency },
      creditInputs,
      scopeToRuleIds: this.scopeToRuleIds,
    });

    let assessmentEvent = null;
    if (result.ok) {
      assessmentEvent = event({
        type: "TAX_CALCULATED",
        aggregateType: "tax_assessment",
        aggregateId: assessmentId,
        occurredAt: now ?? new Date().toISOString(),
        payload: {
          assessment_id: assessmentId,
          lot_id: lotId,
          profile_id: lot.profile_id,
          tax_point_id: taxPointId,
          invoice_id: invoiceId ?? null,
          taxable_price: result.price.taxable_price,
          currency: result.price.currency,
          rate: result.rule.rate,
          tax_amount: result.tax_amount,
          is_exempt: result.rule.is_exempt,
          credit: result.credit,
          formula: result.formula,
          explanation: result.explanation,
        },
        summary: `计税 ${result.tax_amount} ${currency}（${(result.rule.rate * 100).toFixed(2)}%${
          result.rule.is_exempt ? "，阶段性免税" : ""
        }）`,
        correlationId,
      });
    }

    return {
      evaluation,
      taxPoint: tp,
      result,
      taxPointEvent,
      assessmentEvent,
    };
  }
}

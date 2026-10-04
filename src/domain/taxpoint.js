// 应税时点（纳税义务发生时间）判定。跨生效日的合同签订、完工入库、开票、出库，
// 以法定规则决定唯一时点，再用该时点选择法规版本——而不是按销售系统里商品名称当前对应的税率。
//
// 采用的结算方式规则（从价应税消费品销售，常见情形）：
// - advance_payment 预收货款：发货（出库）时点；
// - deferred_payment / installment 赊销、分期收款：合同约定收款日，无约定则出库时点；
// - direct_payment 直接收款：收讫销售款或取得索款凭据当天；本域中以先开票/出库较早者近似，
//   并要求显式记录 payment_received_at 时优先采用；
// 任何情形下，已先开具发票的，开票时点优先（不晚于上述结果）。

export function determineTaxPoint({ contract, lot, line, invoice, paymentReceivedAt }) {
  const outboundMs = lot?.movements
    .filter((m) => m.kind === "outbound")
    .map((m) => m.at_ms)
    .sort((a, b) => a - b)[0] ?? null;

  const invoiceMs = invoice ? invoice.issued_at_ms : null;
  const paymentMs = paymentReceivedAt ? Date.parse(paymentReceivedAt) : null;

  const settlement = contract?.settlement?.kind ?? "direct_payment";
  const candidates = [];
  const reasons = [];

  if (settlement === "advance_payment") {
    if (outboundMs != null) { candidates.push([outboundMs, "预收货款：发货（出库）时点"]); }
  } else if (settlement === "deferred_payment" || settlement === "installment") {
    const agreed = contract?.agreed_receipt_dates_ms?.[0] ?? null;
    if (agreed != null) candidates.push([agreed, "赊销/分期：合同约定收款日"]);
    else if (outboundMs != null) candidates.push([outboundMs, "赊销/分期无约定收款日：出库时点"]);
  } else {
    if (paymentMs != null) candidates.push([paymentMs, "直接收款：收讫销售款时点"]);
    if (outboundMs != null) candidates.push([outboundMs, "直接收款：货物交付（出库）时点"]);
  }

  let [baseMs, basis] = candidates.sort((a, b) => a[0] - b[0])[0] ?? [null, "缺少合同、出库与收款信息，无法判定"];

  // 先开发票的，以开票日为准。
  if (invoiceMs != null && (baseMs == null || invoiceMs < baseMs)) {
    baseMs = invoiceMs;
    basis = "先开具发票：开票时点";
  }

  return {
    tax_point_ms: baseMs,
    basis,
    settlement,
    facts: {
      contract_signed_ms: contract?.signed_at_ms ?? null,
      completed_at_ms: lot?.completed_at_ms ?? null,
      outbound_ms: outboundMs,
      invoice_ms: invoiceMs,
      payment_received_ms: paymentMs,
      agreed_receipt_ms: contract?.agreed_receipt_dates_ms?.[0] ?? null,
    },
  };
}

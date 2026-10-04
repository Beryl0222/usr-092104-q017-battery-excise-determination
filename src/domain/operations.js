// 生产批次、组成物料（BOM）、仓库领域事件、合同与发票投影。
// 仓库事件（STOCK_INBOUND/OUTBOUND/RETURNED）沿用仓库领域定义，本系统只消费，不改其语义。

import { fold } from "./store.js";

export function projectOperations(events) {
  return fold(
    events,
    () => ({
      lots: new Map(), // lot_id -> {..., components: [{component_lot_id, qty}], movements: []}
      contracts: new Map(),
      invoices: new Map(),
    }),
    {
      PRODUCTION_LOT_RECORDED: (s, e) => {
        const p = e.payload;
        s.lots.set(p.lot_id, {
          lot_id: p.lot_id,
          profile_id: p.profile_id,
          quantity: p.quantity,
          unit: p.unit ?? "个",
          completed_at_ms: p.completed_at ? Date.parse(p.completed_at) : Date.parse(e.occurred_at),
          components: [],
          movements: [],
        });
      },
      COMPONENT_CONSUMED: (s, e) => {
        const p = e.payload;
        const parent = s.lots.get(p.parent_lot_id);
        if (parent) parent.components.push({ component_lot_id: p.component_lot_id, quantity: p.quantity });
      },
      STOCK_INBOUND:
        moveHandler("inbound"),
      STOCK_OUTBOUND:
        moveHandler("outbound"),
      STOCK_RETURNED:
        moveHandler("returned"),
      CONTRACT_SIGNED: (s, e) => {
        const p = e.payload;
        s.contracts.set(p.contract_id, {
          contract_id: p.contract_id,
          lines: p.lines ?? [], // [{lot_id, quantity, unit_price_ex_vat, currency}]
          settlement: p.settlement ?? { kind: "other" },
          agreed_receipt_dates_ms: (p.agreed_receipt_dates ?? []).map((x) => Date.parse(x)),
          signed_at_ms: Date.parse(p.signed_at ?? e.occurred_at),
        });
      },
      INVOICE_ISSUED:
        invoiceHandler(false),
      INVOICE_RED_ISSUED:
        invoiceHandler(true),
    },
  );
}

function moveHandler(kind) {
  return (s, e) => {
    const p = e.payload;
    const lot = s.lots.get(p.lot_id);
    if (lot) {
      lot.movements.push({
        kind,
        quantity: p.quantity,
        at_ms: Date.parse(p.at ?? e.occurred_at),
        ref: p.ref ?? null,
        source_event_id: e.event_id,
        causation_id: e.causation_id ?? null,
      });
    }
  };
}

function invoiceHandler(red) {
  return (s, e) => {
    const p = e.payload;
    s.invoices.set(p.invoice_id, {
      invoice_id: p.invoice_id,
      red,
      original_invoice_id: p.original_invoice_id ?? null,
      lines: p.lines ?? [],
      amount_ex_vat: p.amount_ex_vat,
      issued_at_ms: Date.parse(p.issued_at ?? e.occurred_at),
    });
  };
}

export function outboundOf(lot, contractLine) {
  return lot.movements
    .filter((m) => m.kind === "outbound" && (contractLine == null || m.quantity <= contractLine.quantity + 1e-9))
    .sort((a, b) => a.at_ms - b.at_ms);
}

// 仓库领域事件适配器：把仓库基础数据事件翻译为税务领域事件。
// 约定的仓库事件（沿用仓库域）：
//   GoodsCompletedToStock { event: "GOODS_COMPLETED_TO_STOCK", lot_id, completed_at, quantity, unit, warehouse_ref }
//   GoodsOutbound         { event: "GOODS_OUTBOUND", supply_id, lot_id, dispatched_at, quantity, unit, warehouse_event_id }
//   BomConsumption        { event: "BOM_CONSUMPTION", lot_id, module_lot_id, quantity_consumed, unit }
// 翻译规则只搬运事实字段，绝不推断税务分类或税率。

export class WarehouseAdapter {
  constructor(service) {
    this.service = service;
  }

  async ingest(actor, warehouseEvent) {
    switch (warehouseEvent.event) {
      case "GOODS_COMPLETED_TO_STOCK":
        return this.service.completeLot(actor, {
          lot_id: warehouseEvent.lot_id,
          completed_at: warehouseEvent.completed_at,
          inspection_ref: warehouseEvent.inspection_ref || null,
          warehouse_event_id: warehouseEvent.warehouse_event_id || warehouseEvent.event_id,
          occurred_at: warehouseEvent.occurred_at || warehouseEvent.completed_at,
          idempotency_key: warehouseEvent.event_id ? `wh:${warehouseEvent.event_id}` : undefined,
        });
      case "GOODS_OUTBOUND":
        return this.service.dispatch(actor, {
          supply_id: warehouseEvent.supply_id,
          dispatched_at: warehouseEvent.dispatched_at,
          quantity: warehouseEvent.quantity,
          unit: warehouseEvent.unit,
          warehouse_event_id: warehouseEvent.warehouse_event_id || warehouseEvent.event_id,
          occurred_at: warehouseEvent.occurred_at || warehouseEvent.dispatched_at,
          idempotency_key: warehouseEvent.event_id ? `wh:${warehouseEvent.event_id}` : undefined,
        });
      case "BOM_CONSUMPTION":
        return this.service.linkBom(actor, {
          lot_id: warehouseEvent.lot_id,
          module_lot_id: warehouseEvent.module_lot_id,
          quantity_consumed: warehouseEvent.quantity_consumed,
          unit: warehouseEvent.unit,
          warehouse_event_id: warehouseEvent.warehouse_event_id || warehouseEvent.event_id,
          occurred_at: warehouseEvent.occurred_at,
          idempotency_key: warehouseEvent.event_id ? `wh:${warehouseEvent.event_id}` : undefined,
        });
      default: {
        const err = new Error(`未知仓库事件：${warehouseEvent.event}`);
        err.code = "UNKNOWN_WAREHOUSE_EVENT";
        throw err;
      }
    }
  }
}

// 只追加事件日志，内存实现。所有领域状态都通过 fold 重放得到，
// 因此任何历史时点（as_of）、任何时区展示都可以重新计算，不保留可变快照。

import { validateEvent } from "../validator.js";

export class EventStore {
  constructor() {
    this.events = [];
    this.streamVersion = new Map(); // aggregate_id -> 最新 version
  }

  append(event) {
    const expected = (this.streamVersion.get(event.aggregate_id) ?? 0) + 1;
    if (event.version == null) event.version = expected;
    const errors = validateEvent(event);
    if (errors.length > 0) {
      throw new Error(`事件校验失败（${event.event_id ?? "?"}）：\n- ${errors.join("\n- ")}`);
    }
    if (event.version !== expected) {
      throw new Error(
        `${event.aggregate_id} 版本冲突：期望 ${expected}，收到 ${event.version}（事件 ${event.event_id}）`,
      );
    }
    if (this.events.some((e) => e.event_id === event.event_id)) {
      throw new Error(`event_id 重复：${event.event_id}`);
    }
    this.events.push(event);
    this.streamVersion.set(event.aggregate_id, expected);
    return event;
  }

  // 重放至 asOfMs（不含该时刻）为止的事件；不传则全量。
  replay({ asOfMs = Infinity } = {}) {
    return this.events.filter((e) => Date.parse(e.occurred_at) < asOfMs);
  }

  byAggregate(aggregateId, { asOfMs = Infinity } = {}) {
    return this.replay({ asOfMs }).filter((e) => e.aggregate_id === aggregateId);
  }
}

// 按 aggregate_type 分组折叠投影。
export function fold(events, initial, handlers) {
  const state = initial();
  for (const e of events) {
    const h = handlers[e.event_type];
    if (h) h(state, e);
  }
  return state;
}

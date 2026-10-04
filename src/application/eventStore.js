// 事件存储：内存为主，可选 JSONL 持久化。
// 不变量：event_id 与 idempotency_key 唯一；聚合 version 连续；重放按 occurred_at（法定时刻）排序。

import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { validateEvent } from "../domain/events.js";

let seqCounter = 0;

export class EventStore {
  constructor({ file } = {}) {
    this.file = file || null;
    this.events = [];
    this.versions = new Map(); // aggregate_id -> 当前版本
    this.eventIds = new Set();
    this.idempotencyKeys = new Set();
  }

  static async fromFile(file) {
    const store = new EventStore({ file });
    if (file && existsSync(file)) {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        store.ingestLoaded(event);
      }
    }
    return store;
  }

  ingestLoaded(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`已存事件 ${event.event_id} 校验失败：${errors.join("；")}`);
    if (this.eventIds.has(event.event_id)) return; // 重放文件幂等
    this.index(event);
    event._seq = ++seqCounter;
    this.events.push(event);
  }

  async append(event) {
    const errors = validateEvent(event);
    if (errors.length) {
      const err = new Error(`事件校验失败：${errors.join("；")}`);
      err.code = "VALIDATION_FAILED";
      err.errors = errors;
      throw err;
    }
    if (this.eventIds.has(event.event_id)) throw new Error(`event_id 已存在：${event.event_id}`);
    if (event.idempotency_key && this.idempotencyKeys.has(event.idempotency_key))
      throw new Error(`idempotency_key 已使用：${event.idempotency_key}`);

    const current = this.versions.get(event.aggregate_id) || 0;
    if (event.version !== current + 1)
      throw new Error(
        `聚合 ${event.aggregate_id} 版本不连续：期望 ${current + 1}，实际 ${event.version}`
      );

    this.index(event);
    event._seq = ++seqCounter;
    this.events.push(event);
    if (this.file) await appendFile(this.file, JSON.stringify(event) + "\n");
    return event;
  }

  index(event) {
    this.eventIds.add(event.event_id);
    if (event.idempotency_key) this.idempotencyKeys.add(event.idempotency_key);
    this.versions.set(event.aggregate_id, event.version);
  }

  // 重放：asOf（含）之前的事件，按法定时刻排序，同时刻按写入顺序。
  stream({ asOf } = {}) {
    const cutoff = asOf ? new Date(asOf).getTime() : Infinity;
    return this.events
      .filter((e) => Date.parse(e.occurred_at) <= cutoff)
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a._seq - b._seq)
      .map(stripInternal);
  }

  all() {
    return [...this.events].sort((a, b) => a._seq - b._seq).map(stripInternal);
  }
}

function stripInternal(e) {
  const { _seq, ...rest } = e;
  return rest;
}

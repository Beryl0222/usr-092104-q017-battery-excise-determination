// 事件工厂：集中生成信封，统一时区、版本与关联标识。
let seq = 0;
export function nextId(prefix) {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

export function resetIds() {
  seq = 0;
}

export function event({
  type,
  aggregateType,
  aggregateId,
  occurredAt,
  payload = {},
  version,
  summary,
  causationId,
  correlationId,
  eventId,
}) {
  const e = {
    event_id: eventId ?? nextId("evt"),
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version,
    summary: summary ?? type,
    payload,
  };
  if (causationId) e.causation_id = causationId;
  if (correlationId) e.correlation_id = correlationId;
  return e;
}

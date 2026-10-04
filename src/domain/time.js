// 时间与生效区间：所有边界按法规所属时区的当地日历日判定，可重放。
// 语义：生效起始日 00:00（含）起适用；effective_end 缺省为开放区间，
// 否则有效至结束日当天结束（半开区间 [start 00:00, end 次日 00:00)）。

const MS_PER_DAY = 86_400_000;

function partsAt(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const entries = dtf
    .formatToParts(new Date(utcMs))
    .filter((p) => p.type !== "literal")
    .map((p) => [p.type, p.value]);
  const p = Object.fromEntries(entries);
  const hour = +p.hour === 24 ? 0 : +p.hour; // 某些环境在 UTC 午夜返回 24
  return { year: +p.year, month: +p.month, day: +p.day, hour, minute: +p.minute, second: +p.second };
}

// 指定 UTC 时刻在 timeZone 相对 UTC 的偏移（毫秒）。
function offsetMsAt(utcMs, timeZone) {
  const p = partsAt(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// 当地日历日 YYYY-MM-DD 00:00 对应的 UTC 时刻（迭代消除夏令时跳跃误差）。
export function localDayStartUtc(day, timeZone) {
  assertDay(day);
  if (!isSupportedTimeZone(timeZone)) throw new Error(`不支持的时区：${timeZone}`);
  const [y, m, d] = day.split("-").map(Number);
  const midnightWall = Date.UTC(y, m - 1, d, 0, 0, 0);
  let utc = midnightWall - offsetMsAt(midnightWall, timeZone);
  for (let i = 0; i < 4; i++) {
    const next = midnightWall - offsetMsAt(utc, timeZone);
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

// 当地日历日次日 00:00（半开区间右端，不含）。
export function localDayEndUtcExclusive(day, timeZone) {
  return new Date(localDayStartUtc(day, timeZone).getTime() + MS_PER_DAY);
}

// 某时刻在指定时区的当地日历日 YYYY-MM-DD。
export function localDayOf(instant, timeZone) {
  const t = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  const p = partsAt(t, timeZone);
  return `${p.year.toString().padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dayInRange(day, start, end) {
  if (day < start) return false;
  if (end && day > end) return false;
  return true;
}

// 规则在给定时刻是否生效（半开区间，按规则时区判定）。
export function ruleEffectiveAt(rule, instant) {
  const t = instant instanceof Date ? instant : new Date(instant);
  const start = localDayStartUtc(rule.effective_start, rule.time_zone);
  if (t.getTime() < start.getTime()) return false;
  if (rule.effective_end) {
    const endExclusive = localDayEndUtcExclusive(rule.effective_end, rule.time_zone);
    if (t.getTime() >= endExclusive.getTime()) return false;
  }
  return true;
}

export function assertDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`非法日历日：${day}`);
}

export function isSupportedTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 同一 rule_code 的两个版本生效区间是否重叠（不允许重叠）。
export function intervalsOverlap(a, b) {
  return (
    !(a.effective_end && b.effective_start > a.effective_end) &&
    !(b.effective_end && a.effective_start > b.effective_end)
  );
}

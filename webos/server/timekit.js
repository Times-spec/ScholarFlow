'use strict';
/**
 * 时间工具（文档 §4.3）：
 * - 服务端保存绝对时间 + IANA 时区名；前端不得只发"今天下午"这种相对描述。
 * - 计算统一转为 epoch 毫秒；展示按场所时区格式化。
 * - 零依赖实现：固定偏移时区（Asia/Shanghai = +08:00 无夏令时）；其他时区回退 Intl。
 */

const FIXED_OFFSETS = { 'Asia/Shanghai': 8 * 60, 'Asia/Chongqing': 8 * 60, 'Asia/Urumqi': 8 * 60 };

function offsetMinutes(tz, ms) {
  if (FIXED_OFFSETS[tz] != null) return FIXED_OFFSETS[tz];
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(ms));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return (asUTC - ms) / 60000;
  } catch (e) {
    return FIXED_OFFSETS['Asia/Shanghai'];
  }
}

/** 某时区的"YYYY-MM-DD HH:mm" → epoch ms */
function zonedTimeToMs(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guessUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off = offsetMinutes(tz, guessUtc);
  return guessUtc - off * 60000;
}

/** epoch ms → 该时区的 {dateStr, hhmm, iso, minutesOfDay} */
function msToZoned(ms, tz) {
  const off = offsetMinutes(tz, ms);
  const local = new Date(ms + off * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const hhmm = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const sign = off >= 0 ? '+' : '-';
  const offAbs = Math.abs(off);
  const iso = `${dateStr}T${hhmm}:00${sign}${pad(Math.floor(offAbs / 60))}:${pad(offAbs % 60)}`;
  return { dateStr, hhmm, iso, minutesOfDay: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function nowInZone(tz) { return msToZoned(Date.now(), tz); }

/** "HH:mm" 窗口 → 当日毫秒区间；支持跨午夜（如 22:00-02:00） */
function windowToMs(dateStr, win, tz) {
  const start = zonedTimeToMs(dateStr, win[0], tz);
  let end = zonedTimeToMs(dateStr, win[1], tz);
  if (end <= start) end += 24 * 3600 * 1000;
  return [start, end];
}

/** 判断 ms 是否落在任一窗口内（窗口为 ["HH:mm","HH:mm"] 数组，支持跨午夜） */
function inWindows(ms, windows, tz) {
  if (!windows || !windows.length) return true;
  for (const w of windows) {
    const z0 = msToZoned(ms, tz);
    const [s, e] = windowToMs(z0.dateStr, w, tz);
    if (ms >= s && ms < e) return true;
    // 跨午夜窗口从前一日延伸到今天凌晨的情形
    const zy = msToZoned(ms - 24 * 3600 * 1000, tz);
    const [s2, e2] = windowToMs(zy.dateStr, w, tz);
    if (s2 !== s && ms >= s2 && ms < e2) return true;
  }
  return false;
}

/** ms 之后最近一次窗口开启时间（若当前已在窗口内返回 null） */
function nextWindowOpen(ms, windows, tz) {
  if (!windows || !windows.length) return null;
  if (inWindows(ms, windows, tz)) return null;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const probe = msToZoned(ms + dayOffset * 24 * 3600 * 1000, tz);
    for (const w of windows) {
      const [s, e] = windowToMs(probe.dateStr, w, tz);
      if (s >= ms && s < e) return s;
    }
  }
  return null; // 两天内无窗口 → 视为不可达
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分钟` : `${h} 小时`;
}

module.exports = { zonedTimeToMs, msToZoned, nowInZone, windowToMs, inWindows, nextWindowOpen, fmtDuration };

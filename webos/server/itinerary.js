'use strict';
/**
 * 城市多日行程规划器（导游平台的"行前规划"层）。
 * 与单场所游览助手（planner.js）的分工：
 *  - planner.js：某个场所内的高精度步行路线（时间窗 + 路网 + 到站确认）；
 *  - itinerary.js：跨场所的城市级多日行程（场所组合 + 每日节奏 + 预算估算）。
 * 原则与既有产品一致：确定性算法、不虚构事实、未核验信息明确标注。
 */
const { haversineM } = require('./geo');

const E = {
  badRequest: (msg, details) => Object.assign(new Error(msg), { code: 'BAD_REQUEST', details }),
};

const MEAL_BY_BUDGET = { economy: 80, comfort: 150, premium: 260 };
const SIZE_WEIGHT = { large: 3, medium: 2, small: 1 };
const KIND_NIGHT = ['街区', '夜景', '都市观光'];

function venueScore(v, interests) {
  let s = (v.rating || 4) * 2;
  if (v.worldHeritage) s += 1.5;
  if (v.level === '5A') s += 2;
  else if (v.level === '4A') s += 1;
  const tags = v.tags || [];
  if (interests && interests.length) {
    for (const it of interests) if (tags.includes(it)) s += 1.5;
  } else {
    s += 0.5; // 不指定兴趣时轻微偏向大众标签（tags 多为综合型）
  }
  const crowd = v.crowd || '';
  if (crowd === '极高') s -= 1.2;
  else if (crowd === '高') s -= 0.4;
  return s;
}

/** 场所每天可承载量：large 占全天，medium 占半天，small 可做晚上档 */
function capacityOf(v) {
  return SIZE_WEIGHT[v.size] || 2;
}

function pickTopPois(v, max = 4) {
  const must = (v.pois || []).filter((p) => p.mustSee);
  const rest = (v.pois || []).filter((p) => !p.mustSee);
  return [...must, ...rest].slice(0, max).map((p) => ({ name: p.name, brief: p.brief, mustSee: !!p.mustSee, narrationId: p.n || null }));
}

function ticketOf(v) {
  const t = v.ticket || {};
  return {
    referencePriceCny: t.referencePriceCny ?? null,
    known: !!t.known,
    note: t.note || (t.known ? '' : '票价未核验，以官方公示与现场为准'),
  };
}

function distanceTip(a, b, hub) {
  if (!a || !b) return '';
  const d = Math.round(haversineM(a.coord, b.coord));
  const km = d / 1000;
  if (km < 2) return `两地相距约 ${(d).toFixed(0)} 米，步行可达（直线估算）`;
  if (km < 8) return `两地相距约 ${km.toFixed(1)} 公里，建议地铁/公交（直线估算，实际路程更远）`;
  return `两地相距约 ${km.toFixed(1)} 公里，建议打车或地铁（直线估算，实际路程更远）`;
}

/**
 * 确定性多日行程：
 * 输入 { cityId, days(1-7), interests[], pace(easy|normal|active), budget(economy|comfort|premium), people }
 * 输出 { days:[{am, pm, night, tips, budgetCny}], totals, notices }
 */
function planItinerary(hub, { cityId, days, interests, pace, budget, people }) {
  const city = hub.getCity(cityId);
  if (!city) throw E.badRequest('城市不存在', { field: 'cityId' });
  const dayCount = Math.min(7, Math.max(1, Number(days) || 1));
  const paceKey = ['easy', 'normal', 'active'].includes(pace) ? pace : 'normal';
  const budgetKey = ['economy', 'comfort', 'premium'].includes(budget) ? budget : 'comfort';
  const peopleCount = Math.min(20, Math.max(1, Number(people) || 2));

  const venues = city.venues.slice();
  if (!venues.length) throw E.badRequest('该城市暂无场所数据');
  const scored = venues
    .map((v) => ({ v, score: venueScore(v, interests) }))
    .sort((a, b) => b.score - a.score || a.v.id.localeCompare(b.v.id)); // 稳定排序

  // 每日容量（以"半天=2"计）：easy=3（一天一主游），normal=5（大场所+夜间/补充），active=7（一天三处）
  const dayCapacity = paceKey === 'easy' ? 3 : paceKey === 'normal' ? 5 : 7;
  const dayBuckets = Array.from({ length: dayCount }, () => ({ used: 0, items: [] }));

  const assigned = new Set();
  const placeIn = (v, preferDay = null) => {
    const need = capacityOf(v);
    const order = [];
    if (preferDay != null) order.push(preferDay);
    for (let d = 0; d < dayCount; d++) if (d !== preferDay) order.push(d);
    for (const d of order) {
      if (dayBuckets[d].used + need <= dayCapacity) {
        dayBuckets[d].items.push(v);
        dayBuckets[d].used += need;
        assigned.add(v.id);
        return d;
      }
    }
    return null;
  };

  // 1) 大场所优先落位（各自占一天；尽量与前一天场所拉开距离）
  let lastCenter = null;
  for (const { v } of scored) {
    if (assigned.has(v.id) || v.size !== 'large') continue;
    let bestDay = null, bestGap = -1;
    for (let d = 0; d < dayCount; d++) {
      if (dayBuckets[d].used + 3 > dayCapacity) continue;
      const center = dayBuckets[d].items[0];
      const gap = center ? Math.min(haversineM(center.coord, v.coord), 20000) : 20000;
      if (gap > bestGap) { bestGap = gap; bestDay = d; }
    }
    const d = placeIn(v, bestDay);
    if (d != null) lastCenter = v;
  }
  // 2) 中场所：按分数依次放入尚有容量的天；同天尽量就近（组合成片区）
  for (const { v } of scored) {
    if (assigned.has(v.id) || v.size !== 'medium') continue;
    let bestDay = null, bestCost = Infinity;
    for (let d = 0; d < dayCount; d++) {
      if (dayBuckets[d].used + 2 > dayCapacity) continue;
      const first = dayBuckets[d].items.find((x) => x.size !== 'small') || dayBuckets[d].items[0];
      const cost = first ? haversineM(first.coord, v.coord) : 0;
      if (cost < bestCost) { bestCost = cost; bestDay = d; }
    }
    if (bestDay != null) placeIn(v, bestDay);
  }
  // 3) 小场所：白天放不下就当夜间档（街区/夜景优先），仍放不下忽略
  const nightKinds = KIND_NIGHT;
  for (const { v } of scored) {
    if (assigned.has(v.id) || v.size !== 'small') continue;
    let done = placeIn(v);
    if (done == null && (nightKinds.includes(v.kind) || (v.tags || []).some((t) => nightKinds.includes(t)))) {
      const d = v.bestSeason && /夜/.test(v.bestSeason) ? 0 : dayCount - 1;
      const bucket = dayBuckets[d];
      if (!bucket.items.some((x) => nightKinds.includes(x.kind) || (x.tags || []).some((t) => nightKinds.includes(t)))) {
        bucket.items.push(v); assigned.add(v.id); bucket.night = bucket.night || v;
      }
    }
  }

  // 4) 组装每日行程：白天按地理就近排序，街区类放晚上
  const notices = [];
  let placedCount = 0;
  const outDays = dayBuckets.map((bucket, di) => {
    const items = bucket.items;
    placedCount += items.length;
    const dayItems = items.filter((v) => v !== bucket.night);
    // 就近链：从第一个（分数最高）开始贪心串最近邻
    const chain = [];
    const pool = [...dayItems];
    while (pool.length) {
      if (!chain.length) { chain.push(pool.shift()); continue; }
      const last = chain[chain.length - 1];
      let bi = 0, bd = Infinity;
      pool.forEach((cand, i) => {
        const d = haversineM(last.coord, cand.coord);
        if (d < bd) { bd = d; bi = i; }
      });
      chain.push(pool.splice(bi, 1)[0]);
    }
    const am = chain[0] || null;
    const pm = chain[1] || null;
    const night = bucket.night || (chain.length > 2 ? chain[2] : null);
    const slots = [];
    if (am) slots.push({ slot: am.size === 'large' ? '全天主游' : '上午', venueId: am.id, name: am.name, kind: am.kind, size: am.size, level: am.level, suggestedHours: am.suggestedHours, highlights: (am.highlights || []).slice(0, 4), pois: pickTopPois(am), ticket: ticketOf(am), bestSeason: am.bestSeason || null });
    if (pm) slots.push({ slot: '下午', venueId: pm.id, name: pm.name, kind: pm.kind, size: pm.size, level: pm.level, suggestedHours: pm.suggestedHours, highlights: (pm.highlights || []).slice(0, 4), pois: pickTopPois(pm), ticket: ticketOf(pm), bestSeason: pm.bestSeason || null });
    if (night) slots.push({ slot: '夜间', venueId: night.id, name: night.name, kind: night.kind, size: night.size, level: night.level, suggestedHours: Math.min(night.suggestedHours, 2), highlights: (night.highlights || []).slice(0, 3), pois: pickTopPois(night, 3), ticket: ticketOf(night), bestSeason: night.bestSeason || null });
    const transferTips = [];
    if (am && pm) transferTips.push(`${am.name} → ${pm.name}：${distanceTip(am, pm)}`);
    if ((pm || am) && night) transferTips.push(`${(pm || am).name} → ${night.name}：${distanceTip(pm || am, night)}`);
    const ticketsCny = slots.reduce((sum, s) => sum + (s.ticket.referencePriceCny || 0) * peopleCount, 0);
    const mealCny = MEAL_BY_BUDGET[budgetKey] * peopleCount;
    const transportCny = 40 * peopleCount;
    return {
      day: di + 1,
      theme: slots.map((s) => s.name).join(' · '),
      slots,
      transferTips,
      budgetCny: { tickets: ticketsCny, meals: mealCny, transport: transportCny, total: ticketsCny + mealCny + transportCny },
    };
  });

  if (placedCount < scored.length) {
    notices.push(`因天数与节奏限制，${scored.length - placedCount} 个场所未纳入本行程（可增加天数或选择「紧凑」节奏）。`);
  }
  notices.push('交通提示为坐标直线距离估算，实际以地图导航为准；门票均为参考价（内容库未实地核验），出发前请以官方公示为准。');
  const totals = {
    tickets: outDays.reduce((s, d) => s + d.budgetCny.tickets, 0),
    meals: outDays.reduce((s, d) => s + d.budgetCny.meals, 0),
    transport: outDays.reduce((s, d) => s + d.budgetCny.transport, 0),
  };
  totals.total = totals.tickets + totals.meals + totals.transport;
  return {
    cityId, cityName: city.name, days: dayCount, pace: paceKey, budget: budgetKey, people: peopleCount,
    interests: interests || [],
    itinerary: outDays,
    totals,
    notices,
    reviewStatus: 'library_v1',
    generatedAt: new Date().toISOString(),
    algorithm: 'deterministic-greedy-v1',
  };
}

module.exports = { planItinerary };

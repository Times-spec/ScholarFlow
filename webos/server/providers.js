'use strict';
/**
 * Provider 适配层（文档 §7、§14.3）。
 * - demo 模式：场所包路网即"已核验步道图"，搜索/逆地理/讲解均由本地数据产生，全程明确标注。
 * - 真实模式：填入 Key 后由 AMap/LLM HTTP 适配器接管（接口已预留；注意：未联调前不得宣称集成成功）。
 * - LLM 只负责理解/解释/基于证据的表达；坐标、路由、开放事实永远来自工具/数据（§6.4）。
 */
const fs = require('fs');
const path = require('path');
const { haversineM } = require('./geo');

/* ---------- 场所数据包加载 ---------- */
function loadPacks(rootDir) {
  const dir = path.join(rootDir, 'server', 'data');
  const packs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const pack = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    pack._poiById = new Map(pack.pois.map((p) => [p.id, p]));
    pack._nodeById = new Map(pack.nodes.map((n) => [n.id, n]));
    pack._evById = new Map(pack.evidence.map((e) => [e.id, e]));
    packs.push(pack);
  }
  return packs;
}

/* ---------- 地点搜索（§16.1：消歧后的候选地点，不暴露上游密钥） ---------- */
function searchPlaces(packs, q, venueId) {
  const query = (q || '').trim();
  if (!query) return { results: [] };
  const results = [];
  for (const pack of packs) {
    if (pack.venue.name.includes(query)) {
      results.push({
        kind: 'venue', id: pack.venue.id, name: pack.venue.name,
        city: pack.venue.city, address: pack.venue.nameNote, disambiguation: pack.venue.city,
      });
    }
    if (venueId && pack.venue.id !== venueId) continue;
    for (const poi of pack.pois) {
      if (poi.name.includes(query) || query.includes(poi.name)) {
        const node = pack._nodeById.get(poi.entranceNode);
        results.push({
          kind: 'poi', id: poi.id, venueId: pack.venue.id, name: poi.name,
          city: pack.venue.city, address: `${pack.venue.name}内`, disambiguation: `${pack.venue.name} · ${pack.venue.city}`,
          coord: node ? { lng: node.lng, lat: node.lat, crs: 'GCJ02' } : null,
          status: node ? node.status : 'unknown',
          tags: poi.tags,
        });
      }
    }
    for (const n of pack.nodes) {
      if (n.type === 'entrance' && (n.name.includes(query) || query.includes(n.name))) {
        results.push({
          kind: 'entrance', id: n.id, venueId: pack.venue.id, name: `${pack.venue.name}${n.name}`,
          city: pack.venue.city, address: `${pack.venue.name} · 出入口`,
          coord: { lng: n.lng, lat: n.lat, crs: 'GCJ02' }, status: n.status,
        });
      }
    }
  }
  return { results: results.slice(0, 20), provider: 'demo-venue-pack', demo: true };
}

/* ---------- 逆地理（演示：最近已知点位；失败不应使坐标失效 §5.1-6） ---------- */
function reverseGeocode(packs, point) {
  let best = null;
  for (const pack of packs) {
    for (const n of pack.nodes) {
      const d = haversineM(point, n);
      if (!best || d < best.distanceM) best = { distanceM: d, label: `${pack.venue.name} · ${n.name}`, venueId: pack.venue.id, nodeId: n.id };
    }
  }
  if (best && best.distanceM <= 300) {
    return { ok: true, label: best.label, venueId: best.venueId, nodeId: best.nodeId, distanceM: Math.round(best.distanceM), provider: 'demo-venue-pack', demo: true };
  }
  return { ok: true, label: '所选位置（演示模式无真实地址库）', venueId: null, nodeId: null, provider: 'demo-venue-pack', demo: true };
}

/* ---------- 讲解内容（§11.1 三层结构 + 来源 + claims；音频状态真实记录） ---------- */
function buildGuideContent(pack, poiId, ttsAvailable) {
  const poi = pack._poiById.get(poiId);
  if (!poi || !poi.guide) return null;
  const claims = (poi.guide.claims || []).map((c) => {
    const ev = pack._evById.get(c.evidenceId);
    return { text: c.text, evidenceId: c.evidenceId, legend: !!c.legend, evidenceTitle: ev ? ev.sourceTitle : null, reviewStatus: ev ? ev.reviewStatus : 'unknown' };
  });
  const sources = [...new Set((poi.hoursEvidenceIds || []).concat((poi.guide.claims || []).map((c) => c.evidenceId)))]
    .map((eid) => pack._evById.get(eid))
    .filter(Boolean)
    .map((e) => ({ id: e.id, title: e.sourceTitle, url: e.sourceUrl, retrievedAt: e.retrievedAt, reviewStatus: e.reviewStatus, license: e.license }));
  return {
    poiId,
    contentVersion: `${pack.venue.packVersion}.g1`,
    language: 'zh-CN',
    summary: poi.guide.summary,
    shortScript: poi.guide.shortScript,
    detail: poi.guide.detail,
    claims,
    sources,
    verifiedAt: pack.evidence[0] ? pack.evidence[0].retrievedAt : null,
    audioStatus: ttsAvailable ? 'not_requested' : 'demo_unavailable',
    audioDurationSec: null, // 只有真实合成后才记录时长，不按字数假装精确秒数（§11.1）
    demo: !ttsAvailable,
  };
}

/* ---------- 真实适配器（预留；未联调） ---------- */
async function amapWalkingRoute(cfg, fromLngLat, toLngLat) {
  if (!cfg.amap.webServiceKey) {
    const e = new Error('未配置高德 Web 服务 Key'); e.code = 'PROVIDER_NOT_CONFIGURED'; throw e;
  }
  // 文档 §8.6：GET /v3/direction/walking，解析距离/耗时/折线
  const url = `https://restapi.amap.com/v3/direction/walking?key=${cfg.amap.webServiceKey}&origin=${fromLngLat.join(',')}&destination=${toLngLat.join(',')}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const json = await resp.json();
  if (json.status !== '1') { const e = new Error('amap walking failed: ' + json.info); e.code = 'PROVIDER_RATE_LIMITED'; throw e; }
  const p = json.route.paths[0];
  return { distanceM: Number(p.distance), durationSec: Number(p.duration), polyline: p.steps.map((s) => s.polyline).join(';'), provider: 'amap' };
}

async function llmChat(cfg, messages, opts = {}) {
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    const e = new Error('未配置 LLM'); e.code = 'PROVIDER_NOT_CONFIGURED'; throw e;
  }
  const resp = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model, messages,
      max_tokens: Math.min(opts.maxTokens || 800, cfg.limits.maxLlmTokens),
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) { const e = new Error('llm http ' + resp.status); e.code = 'PROVIDER_RATE_LIMITED'; throw e; }
  const json = await resp.json();
  return json.choices[0].message.content;
}

module.exports = { loadPacks, searchPlaces, reverseGeocode, buildGuideContent, amapWalkingRoute, llmChat };

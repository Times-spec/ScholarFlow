// 游览执行页：下一站优先 + 到站确认 + 快捷重排（提议—确认—提交）+ 讲解播放（§11/§12）
import { get, post, subscribeJob } from './api.js';
import { h, toast, openSheet, closeSheet, SvgMap, makeProjector, fmtMin, fmtKm, fmtClock, loadAmap, AmapRouteMap, svgTurnMarkers } from './ui.js';
import { state, getVenuePack } from './app.js';
import { drawPackBase, drawMapLabel } from './home.js';

export function renderTrip(view, ctx, tripId) {
  const cleanups = [];
  let tripData = null;
  let watchId = null;
  let arrivalSamples = [];
  let speaking = false;
  let routeMap = null; // 当前高德底图实例：重渲染先销毁旧实例，避免 WebGL 上下文泄漏
  let renderSeq = 0;   // 渲染代际计数：并发 reload（到站/切前台/可见性）时旧渲染作废

  // 途中调整的可点选项（AI 兜底路径与服务端 cause 一一对应）
  const quick = [
    ['😮‍💨', '我累了', () => quickReplan('fatigue_reported', {}, '将减少剩余步行、增加休息，并提供提前结束选项')],
    ['🌧️', '下雨了', () => quickReplan('rain_reported', {}, '将减少露天路段，优先室内点位')],
    ['⏭️', '这站不去了', pickSkipStop],
    ['⏳', '排队太久', askQueueTime],
    ['🚧', '这里关门了', pickClosedStop],
    ['⌛', '只剩 30 分钟', askDeadline],
    ['🔙', '我要回去了', () => quickReplan('finish_requested', {}, '将计算回到终点的路线')],
    ['➕', '想加一个地方', pickAddStop],
  ];

  const root = h('div', {});
  view.append(root);

  const bottomBar = h('div', { class: 'bottom-bar hidden' });
  document.getElementById('app').append(bottomBar);
  cleanups.push(() => { bottomBar.remove(); stopSpeak(); if (routeMap) { routeMap.destroy(); routeMap = null; } });

  async function reload() {
    tripData = await get('/v1/trips/' + tripId);
    render();
  }

  function visitedSet() {
    return new Set(tripData.events.filter((e) => e.type === 'arrive_confirm').map((e) => e.data.poiId));
  }
  function skippedSet() {
    return new Set(tripData.events.filter((e) => e.type === 'stop_skipped').map((e) => e.data.poiId));
  }
  function nextStop() {
    const route = tripData.route;
    if (!route) return null;
    const v = visitedSet(), s = skippedSet();
    return route.stops.find((st) => !v.has(st.poiId) && !s.has(st.poiId)) || null;
  }
  function currentNodeId() {
    const route = tripData.route;
    const visited = tripData.events.filter((e) => e.type === 'arrive_confirm');
    if (visited.length) {
      const last = visited[visited.length - 1];
      const stop = route.stops.find((st) => st.poiId === last.data.poiId);
      if (stop) return stop.entranceNodeId;
    }
    return route.startNodeId;
  }

  async function render() {
    const seq = ++renderSeq; // 重渲染代际：await 之后若已有更新的渲染，本轮作废
    root.innerHTML = '';
    const route = tripData.route;
    const trip = tripData.trip;
    if (!route) { root.append(h('div', { class: 'card empty' }, '路线数据缺失')); return; }
    if (trip.status !== 'active' && trip.status !== 'paused') {
      location.hash = '#/finish/' + tripId;
      return;
    }
    const next = nextStop();
    const v = visitedSet(), s = skippedSet();

    /* 地图：已走/未走颜色+线型共同区分（§10.2）；真实路线优先高德底图 */
    const nextIdx0 = next ? route.stops.findIndex((st) => st.poiId === next.poiId) : route.stops.length;
    const isDemoMap = route.legs.length && (route.legs[0].provider || '').startsWith('demo');
    const mapWrap = h('div', { class: 'map-wrap' });
    // 高德地图必须在容器挂载进文档后再创建：脱离文档的容器宽高为 0，
    // AMap 会把画布初始化成 0×0，地图从此一片空白（此前游览页地图空白的根因）
    root.append(mapWrap);
    let usedAmap = false;
    if (!isDemoMap && state.config.amapJsKey) {
      try {
        const AMap = await loadAmap(state.config.amapJsKey, state.config.amapJsSecurityCode);
        if (seq !== renderSeq) return;
        if (routeMap) { routeMap.destroy(); routeMap = null; } // 到站/暂停/切回前台会重渲染
        const div = h('div', {});
        mapWrap.append(div, h('div', { class: 'map-note' }, '高德真实路网 · 虚线=已走过/返程'));
        const rm = new AmapRouteMap(div, { AMap, height: 260 });
        routeMap = rm;
        rm.renderRoute(route, {
          walkedUpto: nextIdx0,
          nextPoiId: next ? next.poiId : null,
          stopState: (st) => v.has(st.poiId) ? 'done' : s.has(st.poiId) ? 'skip' : null,
        });
        usedAmap = true;
      } catch (e) {
        mapWrap.innerHTML = '';
      }
    }
    if (!usedAmap) {
    let pack = null;
    try {
      const planInfo = await get('/v1/plans/' + route.planId);
      pack = await getVenuePack({ id: planInfo.plan.venueId, ref: planInfo.plan.venueRef });
    } catch (e) { /* 真实场所/片区无静态场所包时仅绘制路线 */ }
    if (seq !== renderSeq) return;
    const firstPt = route.legs[0].geometry.coordinates[0];
    const proj = makeProjector(pack ? pack.venue.center : { lng: firstPt[0], lat: firstPt[1] });
    const map = new SvgMap(mapWrap, { height: 260 });
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (p) => { bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x); bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y); };
    if (pack) drawPackBase(map, pack, proj);
    route.legs.forEach((leg, i) => {
      const walked = i < nextIdx0;
      const pts = leg.geometry.coordinates.map(([lng, lat]) => proj.toXY({ lng, lat }));
      pts.forEach(grow);
      const d = pts.map((p, j) => (j ? 'L' : 'M') + p.x + ' ' + p.y).join(' ');
      map.el('path', {
        d, fill: 'none',
        stroke: walked ? '#9aa7a1' : (leg.isReturnLeg ? '#1d4ed8' : '#e8a13c'),
        'stroke-width': walked ? 3 : 4.5, 'stroke-linecap': 'round',
        'stroke-dasharray': walked ? '3 6' : leg.isReturnLeg ? '8 6' : 'none',
        opacity: walked ? 0.7 : 0.95,
      });
    });
    route.stops.forEach((st, i) => {
      const p = proj.toXY({ lng: st.coord[0], lat: st.coord[1] });
      grow(p);
      const done = v.has(st.poiId), skip = s.has(st.poiId), isNext = next && st.poiId === next.poiId;
      map.el('circle', {
        cx: p.x, cy: p.y, r: isNext ? 13 : 10,
        fill: skip ? '#9aa7a1' : done ? '#6b7f76' : isNext ? '#e8a13c' : '#0f6f4f',
        stroke: '#fff', 'stroke-width': 2.5,
      });
      const t = map.el('text', { x: p.x, y: p.y + 4, 'font-size': 11, fill: '#fff', 'text-anchor': 'middle', 'font-weight': 700 });
      t.textContent = skip ? '✕' : done ? '✓' : i + 1;
      drawMapLabel(map, p, st.name, -17);
    });
    svgTurnMarkers(map, route.legs, proj, { walkedUpto: nextIdx0 });
    if (!pack) map.fit(bounds, 60);
    mapWrap.append(h('div', { class: 'map-note' }, (isDemoMap ? '演示地图（虚构场所数据）' : '高德真实路网（示意）') + ' · 灰色虚线=已走过'));
    } // end !usedAmap

    /* 行程状态条 */
    // 重排后新版本只含剩余站点，按"当前版本里的已完成数"会显示成"已完成 0/N"（2026-09-30 修）：
    // 已到访按行程事件累计，剩余按当前版本算，两者分别说明。
    const visitedTotal = new Set(tripData.events.filter((e) => e.type === 'arrive_confirm').map((e) => e.data.poiId)).size;
    const remainingCount = route.stops.filter((st) => !v.has(st.poiId) && !s.has(st.poiId)).length;
    root.append(h('div', { class: 'confirm-bar', style: 'margin-top:10px' },
      h('span', { class: 'cchip' }, `已到访 ${visitedTotal} 站 · 剩余 ${remainingCount} 站`),
      h('span', { class: 'cchip' }, `预计 ${fmtClock(route.endArrivalAt)} 到终点`),
      h('span', { class: 'cchip' }, `路线 v${route.version}`),
      trip.status === 'paused' ? h('span', { class: 'cchip', style: 'background:var(--warn-bg);color:var(--warn)' }, '已暂停') : null));

    /* 到站提示（§11.5：定位辅助提示 + 一键确认；不自动判定） */
    const hintBox = h('div', { style: 'margin-top:10px' });
    root.append(hintBox);

    /* 下一站卡（导游视角：先说"到了看什么"，再说怎么走） */
    if (next) {
      const legToNext = route.legs[nextIdx0];
      const teaserSlot = h('div', { class: 'guide-teaser' }, '看点准备中…');
      const card = h('div', { class: 'card next-stop', style: 'margin-top:10px' },
        h('p', { class: 'card-title' }, '下一站 · 看点'),
        h('h3', {}, next.name, next.locked ? h('span', { class: 'tag lock' }, ' 必去') : null),
        teaserSlot,
        h('div', { class: 'tl-meta', style: 'margin-top:8px' },
          legToNext ? `走过去 ${fmtKm(legToNext.distanceM)}（约 ${fmtMin(legToNext.travelSec)}） · 建议停留 ${fmtMin(next.dwellSec)}` : `建议停留 ${fmtMin(next.dwellSec)}`),
        next.openWindows ? h('div', { class: 'tl-meta' }, '开放：' + next.openWindows.map((w) => w.join('-')).join(' / ')) : null,
        h('div', { class: 'tl-actions', style: 'margin-top:10px' },
          h('button', { class: 'btn btn-primary btn-sm', style: 'padding:10px 18px', onclick: () => confirmArrive(next) }, '我已到达 ✓'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openGuideCard(next) }, '看讲解'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => askGuide(next) }, '问导游'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openExternalNav(next) }, '导航')),
        h('div', { id: 'guide-slot' }));
      root.append(card);
      loadTeaser(next, teaserSlot);   // 到站前就告诉用户"到了看什么"
      startArrivalWatch(next, hintBox);
    } else {
      root.append(h('div', { class: 'card next-stop', style: 'margin-top:10px' },
        h('h3', {}, '所有站点已完成 🎉'),
        h('div', { class: 'tl-meta' }, route.legs[route.legs.length - 1] && route.legs[route.legs.length - 1].isReturnLeg
          ? `返回终点：步行 ${fmtKm(route.legs[route.legs.length - 1].distanceM)}`
          : '可以结束游览了'),
        h('div', { class: 'tl-actions', style: 'margin-top:10px' },
          h('button', { class: 'btn btn-primary btn-sm', onclick: finish }, '结束游览'))));
      if (watchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    }

    /* 途中调整：一句话交给 AI，或用按钮兜底（§12.1） */
    root.append(h('div', { class: 'card' },
      h('button', { class: 'btn btn-primary btn-block', onclick: () => openAdjustSheet() }, '调整行程'),
      h('div', { class: 'tl-meta', style: 'margin-top:6px' }, '可以直接说一句：我累了 / 跳过下一站 / 加一个地方')));

    /* 剩余站点列表 */
    const restCard = h('div', { class: 'card' },
      h('p', { class: 'card-title' }, '行程单'),
      ...route.stops.map((st, i) => {
        const done = v.has(st.poiId), skip = s.has(st.poiId);
        return h('div', {
          class: 'poi-result',
          onclick: () => openGuideCard(st),
        },
          h('div', { class: 'n', style: skip ? 'text-decoration:line-through;color:var(--ink-2)' : '' },
            `${i + 1}. ${st.name} `,
            done ? h('span', { class: 'tag' }, '已到访') : skip ? h('span', { class: 'tag warn' }, '已跳过') : next && st.poiId === next.poiId ? h('span', { class: 'tag lock' }, '下一站') : null),
          h('div', { class: 'a' }, `${fmtClock(st.visitStartAt)} - ${fmtClock(st.departureAt)} · ${st.tags.join('、')}`));
      }));
    root.append(restCard);

    /* 底部操作 */
    bottomBar.classList.remove('hidden');
    bottomBar.innerHTML = '';
    bottomBar.append(
      trip.status === 'active'
        ? h('button', { class: 'btn btn-ghost', onclick: pauseTrip }, '暂停')
        : h('button', { class: 'btn btn-ghost', onclick: resumeTrip }, '继续'),
      h('button', { class: 'btn btn-primary', onclick: finish }, '结束游览'));
  }

  /* ---- 到站确认 ---- */
  async function confirmArrive(stop, confirmType = 'manual') {
    try {
      await post(`/v1/trips/${tripId}/events`, {
        eventId: 'arr_' + stop.poiId + '_' + Date.now(),
        type: 'arrive_confirm',
        data: { poiId: stop.poiId },
        confirmType, // manual=高可信；inferred=定位推断（§11.5）
      });
      toast('已记录到访：' + stop.name);
      stopSpeak();
      await reload();
      // 导游行为：到站后直接把讲解端上来，而不是让用户自己找入口
      try { await openGuideCard(stop); } catch (e) { /* 讲解未就绪时静默 */ }
    } catch (e) { toast(e.message); }
  }

  function startArrivalWatch(stop, hintBox) {
    hintBox.innerHTML = '';
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    if (!navigator.geolocation) return;
    // §5.1-7：开始游览后才启动持续定位；离开页面时清理
    watchId = navigator.geolocation.watchPosition((pos) => {
      const accuracy = pos.coords.accuracy;
      if (accuracy > 50) return; // 精度不足不提示（§11.5）
      const d = haversine(pos.coords.longitude, pos.coords.latitude, stop.coord[0], stop.coord[1]);
      if (d > 40) { arrivalSamples = []; return; }
      const now = Date.now();
      arrivalSamples.push(now);
      arrivalSamples = arrivalSamples.filter((t) => now - t < 20000); // 持续 20 秒多个合格采样
      if (arrivalSamples.length >= 2 && !hintBox.hasChildNodes()) {
        hintBox.append(h('div', { class: 'arrive-hint' },
          `📍 你好像已经到「${stop.name}」附近了（定位推断，精度约 ${Math.round(accuracy)}m）`,
          h('div', { style: 'margin-top:6px' },
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => confirmArrive(stop, 'inferred') }, '是的，我到了'),
            ' ',
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { hintBox.innerHTML = ''; arrivalSamples = []; } }, '还没有'))));
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function openExternalNav(stop) {
    // §12.5：外部导航只表达"导航到下一站"，不宣称会完整执行原线路
    const url = `https://uri.amap.com/navigation?to=${stop.coord[0]},${stop.coord[1]},${encodeURIComponent(stop.name)}&mode=walk&coordinate=gcj02&callnative=1`;
    toast('将打开高德导航到下一站（外部地图按自身规则算路）');
    window.open(url, '_blank');
  }

  /* ---- 讲解（§11.4：手动点击播放；自动播放不假设可用） ---- */
  let utter = null;
  function stopSpeak() {
    speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    utter = null;
  }
  /* ---- 导游能力：到站前看点预告 / 到站讲解 / 现场问答 / 记一笔 ---- */
  const guideCache = new Map();
  async function loadGuide(stop) {
    if (guideCache.has(stop.poiId)) return guideCache.get(stop.poiId);
    const p = get(`/v1/guides/${stop.poiId}?planId=${tripData.route.planId}`).catch(() => null);
    guideCache.set(stop.poiId, p);
    return p;
  }
  async function loadTeaser(stop, slot) {
    const g = await loadGuide(stop);
    if (!g) { slot.textContent = '这个点位暂无已核验讲解，到了可以先看现场标识，或用「问导游」试试'; return; }
    const first = (g.summary || '').split(/[。；]/)[0];
    slot.innerHTML = '';
    // 注意：原生 append 会把 null 变成字符串 "null"，必须先过滤
    slot.append(...[
      h('span', { class: 'tag' }, '到了看什么'),
      first ? first + '。' : '讲解已就绪，点「看讲解」查看',
      g.unverified ? h('span', { class: 'tag warn', style: 'margin-left:6px' }, 'AI 生成未核验') : null,
    ].filter(Boolean));
  }

  async function openGuideCard(stop) {
    const box = h('div', {});
    openSheet(stop.name + ' · 讲解', box);
    const g = await loadGuide(stop);
    if (!g) {
      box.append(h('div', { class: 'empty' }, '这个点位还没有已核验的讲解资料。可以点「问导游」提问，我会如实告诉你有没有资料。'));
      return;
    }
    const speakBtn = h('button', { class: 'btn btn-primary btn-sm' }, '▶ 听讲解');
    speakBtn.onclick = () => {
      if (speaking) { stopSpeak(); speakBtn.textContent = '▶ 听讲解'; return; }
      if (!window.speechSynthesis) { toast('当前环境不支持语音合成，请阅读文本'); return; }
      try {
        utter = new SpeechSynthesisUtterance((g.summary || '') + '。' + (g.shortScript || ''));
        utter.lang = 'zh-CN';
        utter.onend = () => { speaking = false; speakBtn.textContent = '▶ 听讲解'; };
        window.speechSynthesis.speak(utter);
        speaking = true; speakBtn.textContent = '⏸ 停止';
      } catch (e) { toast('播放失败，请阅读文本'); }
    };
    const claimNodes = (g.claims || []).map((c, i) => h('div', { class: 'highlight-item' },
      h('div', { class: 'h-teaser' }, '[' + (i + 1) + '] ' + c.text,
        c.legend ? h('span', { class: 'tag warn', style: 'margin-left:4px' }, '传说') : null),
      c.evidenceTitle ? h('div', { class: 'src' }, '来源：' + c.evidenceTitle) : null));
    box.append(
      h('div', { class: 'guide-block' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '眼前看什么'),
        h('div', {}, g.summary || '（暂无）')),
      h('div', { class: 'guide-block', style: 'margin-top:8px' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '简短讲解'),
        h('div', {}, g.shortScript || '（暂无）')));
    if (claimNodes.length) {
      box.append(h('div', { style: 'margin-top:10px' },
        h('div', { style: 'font-weight:600;margin-bottom:6px' }, '看点与典故'), ...claimNodes));
    }
    if (g.detail) {
      box.append(h('details', { style: 'margin-top:8px' },
        h('summary', { style: 'cursor:pointer;color:var(--green)' }, '深入了解'),
        h('div', { class: 'guide-block' }, g.detail)));
    }
    box.append(...[
      h('div', { class: 'row', style: 'margin-top:10px' }, speakBtn,
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { closeSheet(); addNote(stop); } }, '记一笔')),
      h('div', { class: 'src', style: 'margin-top:8px' }, '来源：' + (g.sources || []).map((x) => x.title).join('；')),
      g.unverified ? h('div', { class: 'src', style: 'color:var(--warn)' }, '⚠ 本讲解为 AI 生成，未经资料核验，仅供参考') : null,
    ].filter(Boolean));
  }

  /** 现场问答：只依据该点位已核验资料回答；没有资料就如实说 */
  function askGuide(stop) {
    const input = h('input', { placeholder: '想问点什么？例如：这里有什么典故？' });
    const ansBox = h('div', {});
    const btn = h('button', { class: 'btn btn-primary btn-sm' }, '问');
    const ask = async () => {
      const q = input.value.trim();
      if (!q) { toast('先输入想问的问题'); return; }
      btn.disabled = true;
      ansBox.innerHTML = '';
      ansBox.append(h('div', { class: 'empty' }, '导游正在查资料…'));
      try {
        const r = await post('/v1/ai/ask', { tripId, planId: tripData.route.planId, poiId: stop.poiId, poiName: stop.name, question: q });
        ansBox.innerHTML = '';
        ansBox.append(h('div', { class: 'ask-answer' },
          r.answer,
          h('div', { class: 'src' }, r.notice || (r.hasMaterial ? '回答仅依据该点位的已核验讲解资料' : '暂无已核验资料')),
          (r.usedClaims && r.usedClaims.length)
            ? h('div', { class: 'src' }, '依据：' + r.usedClaims.map((c) => c.text.slice(0, 24)).join('；'))
            : null,
          (r.sources && r.sources.length) ? h('div', { class: 'src' }, '资料：' + r.sources.map((x) => x.title).join('；')) : null));
      } catch (e) {
        ansBox.innerHTML = '';
        ansBox.append(h('div', { class: 'ask-answer' }, '问不出来：' + e.message));
      } finally { btn.disabled = false; }
    };
    btn.onclick = ask;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    openSheet('问导游 · ' + stop.name, h('div', {},
      h('div', { class: 'tl-meta' }, '只依据该点位已核验的讲解资料回答；资料里没有的，我会直接说没有。'),
      h('div', { class: 'ask-row' }, input, btn),
      ansBox,
      h('div', { class: 'chips', style: 'margin-top:10px' },
        ['这里有什么值得看的？', '有什么典故或传说？', '大概要逛多久？'].map((q) =>
          h('button', { class: 'chip', onclick: () => { input.value = q; ask(); } }, q)))));
  }

  /** 刚离开的那一站（已确认到访的最后一站）：写笔记默认记在它名下 */
  function lastVisitedStop() {
    const route = tripData.route;
    const visits = tripData.events.filter((e) => e.type === 'arrive_confirm');
    if (!visits.length) return null;
    const last = visits[visits.length - 1];
    return route.stops.find((st) => st.poiId === last.data.poiId) || null;
  }

  /** 记一笔：现场感受默认记在"刚逛完的那站"名下（写的是刚看到的，不是要去的） */
  function addNote(stop) {
    const visited = lastVisitedStop();
    const target = visited || stop;
    const ta = h('textarea', { class: 'input', style: 'min-height:70px', placeholder: '写一句此刻的感受，例如：湖边的风很舒服，看到两只白鹭' });
    openSheet('记一笔 · ' + target.name + (visited ? '（刚逛完）' : '（即将前往）'), h('div', {},
      ta,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:8px',
        onclick: async () => {
          const text = ta.value.trim();
          if (!text) { toast('写点什么吧'); return; }
          try {
            await post(`/v1/trips/${tripId}/events`, {
              eventId: 'note_' + target.poiId + '_' + Date.now(), type: 'note',
              data: { poiId: target.poiId, text },
            });
            closeSheet(); toast('已记下这一笔');
          } catch (e) { toast(e.message); }
        },
      }, '保存')));
  }

  /* ---- 调整行程弹层：AI 一句话 + 按钮兜底 ---- */
  function openAdjustSheet() {
    const input = h('textarea', {
      class: 'ai-input', style: 'min-height:62px;border-bottom:1px dashed var(--line)',
      placeholder: '说说想怎么调整，例如：我有点累了 / 跳过下一站 / 再加一个地方 / 五点前必须走',
    });
    const aiBtn = h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:8px' }, '让 AI 安排');
    const reply = h('div', { class: 'tl-meta', style: 'margin-top:6px' });
    aiBtn.onclick = async () => {
      const text = input.value.trim();
      if (!text) { toast('先说一句想怎么调整'); return; }
      aiBtn.disabled = true; aiBtn.textContent = 'AI 正在理解…';
      try {
        const r = await post('/v1/ai/command', { text, tripId });
        reply.textContent = r.reply || '';
        if (r.action === 'replan') {
          const data = {};
          if (r.data.poiId) { data.poiId = r.data.poiId; data.reason = 'user_command'; }
          if (r.data.extraWaitMin) data.extraWaitMin = r.data.extraWaitMin;
          if (r.data.newLatestEndClock) data.newLatestEndClock = r.data.newLatestEndClock;
          closeSheet();
          if (r.cause === 'stop_skipped' && !data.poiId) { pickSkipStop(); return; }
          if (r.cause === 'closure_reported' && !data.poiId) { pickClosedStop(); return; }
          if (r.cause === 'stop_add_requested' && !data.poiId) { pickAddStop(); return; }
          if (r.cause === 'queue_reported' && !data.extraWaitMin) { askQueueTime(); return; }
          if (r.cause === 'deadline_changed' && !data.newLatestEndClock) { askDeadline(); return; }
          quickReplan(r.cause, data, null);
        } else if (!r.reply) {
          reply.textContent = '没太理解，试试"我累了""跳过下一站""再加一个地方"';
        }
      } catch (e) {
        reply.textContent = e.message;
      } finally {
        aiBtn.disabled = false; aiBtn.textContent = '让 AI 安排';
      }
    };
    openSheet('调整行程', h('div', {},
      input,
      h('div', { class: 'tl-meta', style: 'margin-top:6px' }, 'AI 只做行程调整与解答，不会擅自改你的锁定站点'),
      aiBtn, reply,
      h('div', { class: 'field-label', style: 'margin-top:14px' }, '或者直接点'),
      h('div', { class: 'quick-grid' }, quick.map(([e, name, fn]) =>
        h('button', { class: 'quick-btn', onclick: () => { closeSheet(); fn(); } }, h('span', { class: 'e' }, e), name)))));
  }

  /* ---- 快捷重排 ---- */
  function quickReplan(cause, data, confirmText) {
    const doIt = async () => {
      closeSheet();
      toast('正在重排剩余行程…');
      try {
        const r = await post(`/v1/trips/${tripId}/replans`, {
          baseRouteId: tripData.trip.activeRouteVersionId,
          cause, data, currentNodeId: currentNodeId(),
        });
        watchReplanJob(r.jobId);
      } catch (e) {
        if (e.code === 'LOCKED_STOP_SKIP') {
          openSheet('确认跳过锁定点？', h('div', {},
            h('p', {}, e.message),
            h('button', {
              class: 'btn btn-primary btn-block',
              onclick: () => { closeSheet(); quickReplan(cause, { ...data, confirmedUnlock: true }, null); },
            }, '确认放弃锁定并跳过')));
        } else {
          toast(e.message, 3500);
        }
      }
    };
    if (confirmText) {
      openSheet('确认调整', h('div', {},
        h('p', {}, confirmText),
        h('button', { class: 'btn btn-primary btn-block', onclick: doIt }, '确认'),
        h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '取消')));
    } else doIt();
  }

  function watchReplanJob(jobId) {
    const un = subscribeJob(jobId, (evt) => {
      const p = evt.payload || {};
      if (evt.type === 'route.alternative_ready' && p.isReplanProposal) {
        un();
        showProposal(p);
      } else if (evt.type === 'job.failed') {
        un();
        toast(p.message || '重排后不可行，保留当前路线', 4500);
      }
    });
    cleanups.push(un);
  }

  function showProposal(p) {
    // §12.3：差异可见，用户确认后才切换
    openSheet('调整方案（确认后生效）', h('div', {},
      h('ul', { class: 'diff-list' }, (p.diffLines || []).map((l) => h('li', {}, l))),
      h('div', { class: 'tl-meta', style: 'margin-bottom:10px' },
        `新方案：${p.summary.stopCount} 站 · ${fmtKm(p.summary.distanceM)} · ${p.summary.endLabel}`),
      h('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          try {
            await post(`/v1/trips/${tripId}/replans/${p.proposalId}/accept`, {
              baseVersionId: tripData.trip.activeRouteVersionId,
              idempotencyKey: 'acc_' + Date.now(),
            });
            closeSheet();
            toast('已切换到新路线');
            stopSpeak();
            await reload();
          } catch (e) {
            if (e.code === 'ROUTE_VERSION_CONFLICT') {
              closeSheet();
              toast('路线已在别处更新，正在刷新…');
              await reload();
            } else toast(e.message);
          }
        },
      }, '接受新路线'),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => { closeSheet(); toast('已保留原路线'); } }, '保留原路线')));
  }

  function remainingStops() {
    const v = visitedSet(), s = skippedSet();
    return tripData.route.stops.filter((st) => !v.has(st.poiId) && !s.has(st.poiId));
  }
  function pickSkipStop() {
    openSheet('跳过哪一站？', h('div', {}, remainingStops().map((st) =>
      h('div', {
        class: 'poi-result',
        onclick: () => { closeSheet(); quickReplan('stop_skipped', { poiId: st.poiId, reason: 'user_skip' }, `将跳过「${st.name}」并重排剩余行程`); },
      }, h('div', { class: 'n' }, st.name, st.locked ? h('span', { class: 'tag lock' }, ' 必去') : null)))));
  }
  function pickClosedStop() {
    openSheet('哪个点位关闭了？（仅影响你的行程，核验前不会传播）', h('div', {}, remainingStops().map((st) =>
      h('div', {
        class: 'poi-result',
        onclick: () => { closeSheet(); quickReplan('closure_reported', { poiId: st.poiId }, `将从你的行程中排除「${st.name}」`); },
      }, h('div', { class: 'n' }, st.name)))));
  }
  function askQueueTime() {
    const input = h('input', { class: 'input', type: 'number', min: 5, max: 120, value: 20 });
    openSheet('预计还要排多久？', h('div', {},
      h('div', { class: 'field-label' }, '预计等待（分钟）'),
      input,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:10px',
        onclick: () => { const m = Number(input.value) || 20; closeSheet(); quickReplan('queue_reported', { extraWaitMin: m }, null); },
      }, '重新计算时间')));
  }
  function askDeadline() {
    const now = new Date(Date.now() + 30 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const input = h('input', { class: 'input', type: 'time', value: `${pad(now.getHours())}:${pad(now.getMinutes())}` });
    openSheet('新的最晚结束时间', h('div', {},
      h('div', { class: 'field-label' }, '最晚几点前到终点'),
      input,
      h('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:10px',
        onclick: () => { closeSheet(); quickReplan('deadline_changed', { newLatestEndClock: input.value }, null); },
      }, '以此重新规划')));
  }
  function pickAddStop() {
    const input = h('input', { class: 'input', placeholder: '搜索想去的点位…' });
    const list = h('div', {});
    input.addEventListener('input', async () => {
      const q = input.value.trim();
      if (!q) return;
      const r = await get(`/v1/places/search?q=${encodeURIComponent(q)}`);
      list.innerHTML = '';
      for (const item of r.results.filter((x) => x.kind === 'poi')) {
        list.append(h('div', {
          class: 'poi-result',
          onclick: () => { closeSheet(); quickReplan('stop_add_requested', { poiId: item.id }, null); },
        }, h('div', { class: 'n' }, item.name), h('div', { class: 'a' }, item.address)));
      }
    });
    openSheet('想加一个地方', h('div', {}, input, list));
  }

  /* ---- 暂停/继续/结束 ---- */
  async function pauseTrip() {
    await post(`/v1/trips/${tripId}/events`, { type: 'trip_paused', data: {} });
    toast('已暂停（Web 版为前台助手，切后台不保证持续记录）');
    reload();
  }
  async function resumeTrip() {
    await post(`/v1/trips/${tripId}/events`, { type: 'trip_resumed', data: {} });
    reload();
  }
  async function finish() {
    openSheet('结束本次游览？', h('div', {},
      h('p', {}, '结束后将生成本次行程回顾'),
      h('button', {
        class: 'btn btn-primary btn-block',
        onclick: async () => {
          closeSheet();
          try {
            await post(`/v1/trips/${tripId}/finish`, { idempotencyKey: 'fin_' + Date.now() });
            stopSpeak();
            location.hash = '#/finish/' + tripId;
          } catch (e) { toast(e.message); }
        },
      }, '结束并生成回顾'),
      h('button', { class: 'btn btn-ghost btn-block', onclick: closeSheet }, '再逛一会儿')));
  }

  /* ---- 返回恢复（§12.5：visibilitychange/pageshow 触发状态恢复） ---- */
  const onVisible = () => { if (!document.hidden) reload().catch(() => {}); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onVisible);
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  });

  reload().catch((e) => root.append(h('div', { class: 'card empty' }, e.message)));
  return () => cleanups.forEach((f) => f());
}

function haversine(lng1, lat1, lng2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

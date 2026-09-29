'use strict';
/** 夜间闭园 → 一键改到下一个开放时刻 的端到端验收 */
const { open, checker, sleep } = require('C:/Users/24800/.workbuddy/skills/web-ui-bug-repro/scripts/cdp.js');
const BASE = 'http://127.0.0.1:8080';
const c = checker();

async function waitFor(page, expr, ms = 20000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(expr)) return true; } catch (e) {}
    await sleep(step);
  }
  return false;
}

(async () => {
  const page = await open({ url: BASE + '/#/', width: 420, height: 860, settleMs: 2500 });
  try {
    // 园区闭园时段（23:30，已过则顺延到明天）：与运行时刻无关，随时跑都成立
    const closed = new Date();
    closed.setHours(23, 30, 0, 0);
    if (closed.getTime() <= Date.now()) closed.setDate(closed.getDate() + 1);
    const closedAt = closed.getTime();
    await page.evaluate(`(() => {
      const d = {
        step: 3, scene: 'venue', venueId: 'venue_qinghu', venueRef: null, objective: 'highlights',
        origin: { lng: 104.062, lat: 30.659, crs: 'GCJ02', entranceId: 'gate_south', label: '南门', source: 'map_pick' },
        timeMode: 'duration', durationSec: 7200, endpointMode: 'return_to_origin',
        mobility: 'walk', pace: 'normal', interests: [], text: '晚上想逛逛，两小时',
        mustVisit: [], avoid: [], startMode: 'later', startAtMs: ${closedAt}, guideStyle: 'normal',
      };
      localStorage.setItem('st_draft_v1', JSON.stringify(d));
      location.reload();
    })()`);
    await sleep(2500);
    await page.evaluate(`(() => { const b = document.querySelector('.bottom-bar .btn'); if (b) b.click(); })()`);
    const conflictShown = await waitFor(page, `/均已关闭|条件性方案|没有可行方案|已关闭/.test(document.body.textContent)`, 60000);
    const text = await page.evaluate(`document.body.textContent`);
    c.check('闭园时明确告知（非笼统的"没有可行方案"）', conflictShown && /均已关闭/.test(text), text.slice(0, 80));
    const hasChip = await page.evaluate(`[...document.querySelectorAll('.chip')].some(b => /改到.*出发/.test(b.textContent))`);
    c.check('给出可执行出路按钮', hasChip);
    if (hasChip) {
      await page.evaluate(`(() => { const b=[...document.querySelectorAll('.chip')].find(x=>/改到.*出发/.test(x.textContent)); b.click(); })()`);
      const planned = await waitFor(page, `document.querySelectorAll('.route-card').length > 0`, 90000);
      c.check('一键改到开放时段后成功出路线', planned);
      const info = await page.json(`({ hash: location.hash, stops: document.querySelectorAll('.tl-item').length })`);
      c.check('新方案含站点', info.stops >= 1, JSON.stringify(info));
    }
    const errs = await page.errors();
    c.check('无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    await page.close();
  }
  process.exit(c.done() ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR', e.message); process.exit(1); });

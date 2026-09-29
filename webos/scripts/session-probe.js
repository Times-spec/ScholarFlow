'use strict';
/** 会话失效自愈验收：把 token 置为无效/清空服务端会话后，客户端应自动重建而不是卡死 */
const { open, checker, sleep } = require('C:/Users/24800/.workbuddy/skills/web-ui-bug-repro/scripts/cdp.js');

const BASE = 'http://127.0.0.1:8080';
const c = checker();

async function waitFor(page, expr, ms = 15000, step = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(expr)) return true; } catch (e) {}
    await sleep(step);
  }
  return false;
}

async function main() {
  const page = await open({ url: BASE + '/#/', width: 420, height: 860, settleMs: 2500 });
  try {
    // 基线：正常可用
    c.check('基线：首页正常渲染', await page.evaluate(`!!document.querySelector('.ai-input')`));

    // 场景 1：token 是垃圾值（模拟服务端换库/会话被吊销）
    await page.evaluate(`localStorage.setItem('st_session', 'ses_deadbeef_invalid_token')`);
    await page.evaluate(`location.reload()`);
    await sleep(3000);
    const recovered = await waitFor(page, `!!document.querySelector('.ai-input')`, 15000);
    const token1 = await page.evaluate(`(localStorage.getItem('st_session')||'')`);
    c.check('会话无效时自动重建并渲染首页', recovered, '页面仍为：' + (await page.evaluate(`document.body.textContent.slice(0,60)`)));
    c.check('token 已被替换为新会话', token1 && token1 !== 'ses_deadbeef_invalid_token', token1.slice(0, 20));
    c.check('未出现初始化失败卡片', !(await page.evaluate(`/初始化失败|会话凭证/.test(document.body.textContent)`)));

    // 场景 2：token 被删除
    await page.evaluate(`localStorage.removeItem('st_session')`);
    await page.evaluate(`location.reload()`);
    await sleep(3000);
    c.check('无 token 时自动建立访客会话', await waitFor(page, `!!document.querySelector('.ai-input')`, 15000));

    // 场景 3：重建后的会话真的能用（走一次真实请求）
    const ok = await page.evaluate(`fetch('/v1/me/trips', { headers: { authorization: 'Bearer ' + (localStorage.getItem('st_session')||'') } })
      .then(r => r.status).catch(e => 'ERR:' + e.message)`);
    c.check('新会话通过鉴权接口', ok === 200, String(ok));

    // 场景 4：运行时不再出现"会话凭证"报错（用户的原始症状）
    await page.evaluate(`localStorage.setItem('st_session', 'ses_stale_token_xxx')`);
    await page.evaluate(`location.reload()`);
    await sleep(3000);
    // 走一次真实鉴权请求（不依赖具体 UI），应自动换新会话并成功
    const status = await page.evaluate(`fetch('/v1/me/trips', { headers: { authorization: 'Bearer ' + (localStorage.getItem('st_session')||'') } }).then(r => r.status)`);
    const renewed = await page.evaluate(`!!localStorage.getItem('st_session') && localStorage.getItem('st_session') !== 'ses_stale_token_xxx'`);
    const toastText = await page.evaluate(`document.getElementById('toast') ? document.getElementById('toast').textContent : ''`);
    c.check('过期凭证下真实请求自动换新会话并成功', renewed && status === 200 && !/会话凭证/.test(toastText), 'status=' + status + ' toast=' + toastText);

    const errs = await page.errors();
    c.check('无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } finally {
    await page.close();
  }
  process.exit(c.done() ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR', e.message); process.exit(1); });

'use strict';
/** 通过 CDP 在当前 WebView 页面里点击文本匹配的按钮（验收/截图辅助）
 *  用法：node scripts/apk-click.js "开始游览" [端口] */
const http = require('http');

const PORT = Number(process.argv[3] || 9222);
const text = process.argv[2] || '';

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej);
  });
}

(async () => {
  const list = await getJson('/json');
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('NO_PAGE'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const call = (method, params) => new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const expr =
    '(() => { const els = [...document.querySelectorAll("button")]' +
    '.filter(b => b.textContent.indexOf(' + JSON.stringify(text) + ') >= 0 && !b.disabled);' +
    ' if (!els.length) return "NOT_FOUND"; els[0].click();' +
    ' return "CLICKED: " + els[0].textContent.trim().slice(0, 24); })()';
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 200));
  ws.close();
  process.exit(0);
})();

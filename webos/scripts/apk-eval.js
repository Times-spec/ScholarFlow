'use strict';
/** 在 App 的 WebView 里执行一段 JS 并打印结果（验收排查用）
 *  用法：node scripts/apk-eval.js "location.hash" [端口] */
const http = require('http');

const PORT = Number(process.argv[3] || 9222);
const expr = process.argv[2] || '1';

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
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  } else {
    console.log(typeof r.result.result.value === 'string' ? r.result.result.value : JSON.stringify(r.result.result.value));
  }
  ws.close();
  process.exit(0);
})();

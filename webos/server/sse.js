'use strict';
/**
 * SSE 事件流（文档 §9.3）：
 * - 事件编号 seq，支持 afterSeq 断线补偿或轮询快照；SSE 不承担客户端写入。
 * - 取消后不再向已取消任务推送；前端只应用匹配任务与版本的事件。
 */
class SseHub {
  constructor() {
    this.subs = new Map(); // jobId -> Set<res>
  }
  subscribe(jobId, res) {
    if (!this.subs.has(jobId)) this.subs.set(jobId, new Set());
    this.subs.get(jobId).add(res);
    return () => {
      const set = this.subs.get(jobId);
      if (set) { set.delete(res); if (!set.size) this.subs.delete(jobId); }
    };
  }
  publish(jobId, event) {
    const set = this.subs.get(jobId);
    if (!set) return;
    const data = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try { res.write(data); } catch (e) { /* 连接已断开，由 afterSeq 补偿 */ }
    }
  }
}

function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

module.exports = { SseHub, writeSseHead };

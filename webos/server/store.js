'use strict';
/**
 * JSON 文件持久化存储。
 * 说明：文档 §15 推荐 PostgreSQL；零依赖交付采用同构的集合式存储 + 唯一约束 + 原子写文件，
 * 表结构与文档 §15.1 核心表一一对应，后续可平移到 PG。任务采用"数据库业务状态 + outbox 补偿"，
 * 与文档 §17.1「数据库已写但队列未入」要求一致：jobs 先落库，worker 循环扫描待派发任务。
 */
const fs = require('fs');
const path = require('path');

const COLLECTIONS = [
  'users', 'sessions', 'consents', 'intents', 'plans',
  'route_versions', 'jobs', 'job_events', 'trips', 'trip_events',
  'feedback', 'preference_evidence', 'preferences', 'guide_contents',
  'idempotency_keys', 'orders', 'itineraries',
];

class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    for (const c of COLLECTIONS) this.data[c] = [];
    this._saveTimer = null;
    this._load();
  }
  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const c of COLLECTIONS) if (Array.isArray(raw[c])) this.data[c] = raw[c];
      }
    } catch (e) {
      console.error('[store] 数据文件读取失败，从空库启动:', e.message);
    }
  }
  save(immediate) {
    if (this._saveTimer) return;
    const doSave = () => {
      this._saveTimer = null;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file); // 原子替换
    };
    if (immediate) { doSave(); return; }
    this._saveTimer = setTimeout(doSave, 200);
    this._saveTimer.unref && this._saveTimer.unref();
  }

  insert(coll, row) {
    this.data[coll].push(row);
    this.save();
    return row;
  }
  /** 唯一约束插入（对应 §15.3：route_versions(plan_id,version)、trip_events(event_id)、job_events(job_id,seq)） */
  insertUnique(coll, row, keyFn) {
    if (this.data[coll].some((r) => keyFn(r) === keyFn(row))) return null;
    return this.insert(coll, row);
  }
  find(coll, pred) { return this.data[coll].filter(pred); }
  findOne(coll, pred) { return this.data[coll].find(pred) || null; }
  byId(coll, idv) { return this.data[coll].find((r) => r.id === idv) || null; }
  update(coll, idv, patch) {
    const row = this.byId(coll, idv);
    if (!row) return null;
    Object.assign(row, typeof patch === 'function' ? patch(row) : patch);
    this.save();
    return row;
  }
  removeWhere(coll, pred) {
    const before = this.data[coll].length;
    this.data[coll] = this.data[coll].filter((r) => !pred(r));
    if (this.data[coll].length !== before) this.save();
    return before - this.data[coll].length;
  }
}

function createStore(rootDir) {
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return new Store(path.join(dir, 'db.json'));
}

module.exports = { createStore };

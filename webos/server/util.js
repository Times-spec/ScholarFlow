'use strict';
/** 通用工具：ID、错误、JSON 辅助 */
const crypto = require('crypto');

function id(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}
function traceId() {
  return 'tr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
function token() {
  return crypto.randomBytes(24).toString('hex');
}
function nowIso() {
  return new Date().toISOString();
}

/** 统一业务错误（文档 §16.1 错误格式：{code,message,retryable,traceId,details}） */
class ApiError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.code = code;
    this.retryable = !!opts.retryable;
    this.status = opts.status || 400;
    this.details = opts.details || {};
  }
}
const E = {
  badRequest: (msg, details) => new ApiError('BAD_REQUEST', msg, { details }),
  notFound: (msg) => new ApiError('NOT_FOUND', msg, { status: 404 }),
  forbidden: () => new ApiError('FORBIDDEN', '无权访问该资源', { status: 403 }),
  unauthorized: () => new ApiError('UNAUTHORIZED', '缺少或无效的会话凭证', { status: 401 }),
  conflict: (code, msg, details) => new ApiError(code, msg, { status: 409, details }),
};

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ApiError('PAYLOAD_TOO_LARGE', '请求体超过大小限制', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw E.badRequest('请求体不是合法 JSON');
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = { id, traceId, token, nowIso, ApiError, E, readBody, readJson, clamp, deepClone };

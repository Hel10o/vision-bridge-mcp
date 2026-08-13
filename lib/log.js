'use strict';

/**
 * 日志：stderr（人看）+ 按天滚动的文件（事后查账：耗时 / token 用量 / 模型 / 错误码）。
 * 绝对不能写 stdout —— stdout 是 MCP 的 JSON-RPC 通道。
 * 任何 IO 失败都静默降级，日志坏了不能拖垮识图。
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor(config) {
    this.cfg = config;
    this.threshold = LEVELS[config.logLevel] || LEVELS.info;
    this.fileReady = false;
    this.fileBroken = false;
    this.currentDay = '';
    this.stream = null;
    if (config.logEnabled) this._pruneOld();
  }

  _today() {
    // 用本地时间分文件，方便人对照“今天烧了多少额度”
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  _ensureStream() {
    if (!this.cfg.logEnabled || this.fileBroken) return null;
    const day = this._today();
    if (this.stream && this.currentDay === day) return this.stream;
    try {
      fs.mkdirSync(this.cfg.logDir, { recursive: true });
      if (this.stream) this.stream.end();
      this.stream = fs.createWriteStream(path.join(this.cfg.logDir, `${day}.log`), { flags: 'a' });
      this.stream.on('error', () => {
        this.fileBroken = true;
        this.stream = null;
      });
      this.currentDay = day;
      return this.stream;
    } catch {
      this.fileBroken = true;
      return null;
    }
  }

  _pruneOld() {
    try {
      const cutoff = Date.now() - this.cfg.logKeepDays * 86400000;
      for (const name of fs.readdirSync(this.cfg.logDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const f = path.join(this.cfg.logDir, name);
        if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
      }
    } catch {
      /* 日志目录还不存在或没权限，忽略 */
    }
  }

  _write(level, msg, fields) {
    if ((LEVELS[level] || 0) < this.threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${fmtFields(fields)}`;
    // stderr 只输出 warn 以上 + info 的关键事件，避免刷屏
    if (LEVELS[level] >= LEVELS.warn || level === 'info') {
      try {
        process.stderr.write(`[vision-bridge] ${line}\n`);
      } catch {
        /* stderr 断了也不能崩 */
      }
    }
    const s = this._ensureStream();
    if (s) {
      try {
        s.write(line + '\n');
      } catch {
        this.fileBroken = true;
      }
    }
  }

  debug(msg, fields) {
    this._write('debug', msg, fields);
  }
  info(msg, fields) {
    this._write('info', msg, fields);
  }
  warn(msg, fields) {
    this._write('warn', msg, fields);
  }
  error(msg, fields) {
    this._write('error', msg, fields);
  }

  /** 只写文件、不打 stderr（高频细节，比如每次重试） */
  trace(msg, fields) {
    const s = this._ensureStream();
    if (!s) return;
    try {
      s.write(`${new Date().toISOString()} TRACE ${msg}${fmtFields(fields)}\n`);
    } catch {
      this.fileBroken = true;
    }
  }

  close() {
    try {
      if (this.stream) this.stream.end();
    } catch {
      /* ignore */
    }
  }
}

function fmtFields(fields) {
  if (!fields) return '';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 300) : String(v);
    parts.push(`${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

module.exports = { Logger, LEVELS };

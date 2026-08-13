'use strict';

/**
 * 结果缓存：模型经常对同一张图连着追问三四次，每次都重新 base64 上传既费额度又费时间。
 * key = 图片内容 hash + 提示词 + 模型 + 生成参数，所以换图/换问法/换模型都不会串味。
 * memory：进程内 LRU；disk：额外落盘，跨会话复用（MCP 服务器每个会话都会重启）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ResultCache {
  constructor(config, log) {
    this.mode = config.cacheMode; // disk | memory | off
    this.dir = config.cacheDir;
    this.ttl = config.cacheTtlMs;
    this.maxEntries = config.cacheMaxEntries;
    this.memMax = Math.min(64, this.maxEntries);
    this.mem = new Map();
    this.log = log;
    this.setCount = 0;
    this.diskBroken = false;
  }

  get enabled() {
    return this.mode !== 'off';
  }

  key(parts) {
    const h = crypto.createHash('sha256');
    h.update(
      JSON.stringify({
        v: 2,
        images: (parts.imageIds || []).slice().sort(),
        prompt: parts.prompt || '',
        model: parts.model || '',
        style: parts.apiStyle || '',
        base: parts.apiBase || '',
        maxTokens: parts.maxTokens || 0,
        temperature: parts.temperature === undefined ? null : parts.temperature,
      })
    );
    return h.digest('hex');
  }

  _file(key) {
    return path.join(this.dir, `${key.slice(0, 2)}`, `${key}.json`);
  }

  get(key) {
    if (!this.enabled) return null;

    const hit = this.mem.get(key);
    if (hit) {
      // >= ：ttl 为 0 就等于不缓存
      if (Date.now() - hit.savedAt >= this.ttl) {
        this.mem.delete(key);
      } else {
        this.mem.delete(key);
        this.mem.set(key, hit); // LRU：命中后挪到队尾
        return { ...hit, from: 'memory' };
      }
    }

    if (this.mode !== 'disk' || this.diskBroken) return null;
    try {
      const f = this._file(key);
      const st = fs.statSync(f);
      // mtimeMs 带小数，刚写完的文件可能比 Date.now() 略“晚”，先夹到 0
      if (Math.max(0, Date.now() - st.mtimeMs) >= this.ttl) {
        fs.unlinkSync(f);
        return null;
      }
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!rec || typeof rec.text !== 'string') return null;
      this._memSet(key, rec);
      return { ...rec, from: 'disk' };
    } catch {
      return null; // 未命中 / 文件坏了，都当没有
    }
  }

  set(key, value) {
    if (!this.enabled) return;
    const rec = { ...value, savedAt: Date.now() };
    this._memSet(key, rec);
    if (this.mode !== 'disk' || this.diskBroken) return;
    try {
      const f = this._file(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec));
      fs.renameSync(tmp, f); // 原子替换，避免读到半个文件
      if (++this.setCount % 10 === 1) this.prune();
    } catch (e) {
      this.diskBroken = true;
      if (this.log) this.log.warn('磁盘缓存写入失败，本次会话改用内存缓存', { err: e.message });
    }
  }

  _memSet(key, rec) {
    this.mem.delete(key);
    this.mem.set(key, rec);
    while (this.mem.size > this.memMax) this.mem.delete(this.mem.keys().next().value);
  }

  /** 清掉过期项；超出条数上限时按 mtime 淘汰最旧的 */
  prune() {
    if (this.mode !== 'disk' || this.diskBroken) return;
    try {
      const files = [];
      for (const sub of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const d = path.join(this.dir, sub.name);
        for (const name of fs.readdirSync(d)) {
          if (!name.endsWith('.json')) continue;
          const f = path.join(d, name);
          try {
            files.push({ f, mtime: fs.statSync(f).mtimeMs });
          } catch {
            /* 并发删掉了，忽略 */
          }
        }
      }
      const now = Date.now();
      const alive = [];
      for (const x of files) {
        if (now - x.mtime > this.ttl) rm(x.f);
        else alive.push(x);
      }
      if (alive.length > this.maxEntries) {
        alive.sort((a, b) => a.mtime - b.mtime);
        for (const x of alive.slice(0, alive.length - this.maxEntries)) rm(x.f);
      }
    } catch {
      /* 缓存目录还不存在，忽略 */
    }
  }

  /** 返回删除的文件数 */
  clear() {
    let n = 0;
    this.mem.clear();
    try {
      for (const sub of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const d = path.join(this.dir, sub.name);
        for (const name of fs.readdirSync(d)) {
          if (name.endsWith('.json') && rm(path.join(d, name))) n++;
        }
        try {
          fs.rmdirSync(d);
        } catch {
          /* 目录非空，留着 */
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return n;
  }

  stats() {
    let files = 0;
    let bytes = 0;
    try {
      for (const sub of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const d = path.join(this.dir, sub.name);
        for (const name of fs.readdirSync(d)) {
          if (!name.endsWith('.json')) continue;
          files++;
          try {
            bytes += fs.statSync(path.join(d, name)).size;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return { mode: this.mode, memory: this.mem.size, files, bytes };
  }
}

function rm(f) {
  try {
    fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ResultCache };

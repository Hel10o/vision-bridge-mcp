'use strict';

/**
 * 极简测试骨架 + MCP 客户端模拟器。
 * 原则：每个断言都必须能真的失败，整套跑完用退出码表态（0 通过 / 1 失败）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

// ---------- mini test runner ----------

class Suite {
  constructor(name) {
    this.name = name;
    this.cases = [];
    this.beforeAllFn = null;
    this.afterAllFn = null;
  }

  test(title, fn) {
    this.cases.push({ title, fn });
    return this;
  }

  beforeAll(fn) {
    this.beforeAllFn = fn;
    return this;
  }

  afterAll(fn) {
    this.afterAllFn = fn;
    return this;
  }

  async run() {
    const out = { name: this.name, passed: 0, failed: 0, skipped: 0, failures: [] };
    process.stdout.write(`\n━━ ${this.name} ━━\n`);
    if (this.beforeAllFn) {
      try {
        await this.beforeAllFn();
      } catch (e) {
        out.failed++;
        out.failures.push({ title: '(beforeAll)', err: e });
        process.stdout.write(`  ✗ beforeAll 失败: ${e.message}\n`);
        return out;
      }
    }
    for (const c of this.cases) {
      const t0 = Date.now();
      try {
        const r = await c.fn();
        if (r === 'skip') {
          out.skipped++;
          process.stdout.write(`  ○ ${c.title}（跳过）\n`);
          continue;
        }
        out.passed++;
        const ms = Date.now() - t0;
        process.stdout.write(`  ✓ ${c.title}${ms > 300 ? ` (${ms}ms)` : ''}\n`);
      } catch (e) {
        out.failed++;
        out.failures.push({ title: c.title, err: e });
        process.stdout.write(`  ✗ ${c.title}\n      ${String((e && e.message) || e).split('\n').join('\n      ')}\n`);
      }
    }
    if (this.afterAllFn) {
      try {
        await this.afterAllFn();
      } catch (e) {
        process.stdout.write(`  ! afterAll 清理失败: ${e.message}\n`);
      }
    }
    return out;
  }

  async main() {
    const r = await this.run();
    process.stdout.write(`\n${r.failed ? '✗ 失败' : '✓ 通过'}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped\n`);
    process.exit(r.failed ? 1 : 0);
  }
}

const suite = (name) => new Suite(name);

// ---------- 断言补充 ----------

function assertIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${msg || '内容不匹配'}\n  期望包含: ${needle}\n  实际内容: ${String(haystack).slice(0, 500)}`);
  }
}

function assertNotIncludes(haystack, needle, msg) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${msg || '内容不应包含'}: ${needle}\n  实际内容: ${String(haystack).slice(0, 500)}`);
  }
}

async function assertThrows(fn, matcher, msg) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${msg || '期望抛出异常，但没有'}`);
  if (matcher) {
    if (typeof matcher === 'string') assertIncludes(threw.message + ' ' + (threw.code || ''), matcher, msg || '异常内容不匹配');
    else if (matcher instanceof RegExp && !matcher.test(threw.message)) throw new Error(`异常信息不匹配 ${matcher}：${threw.message}`);
    else if (typeof matcher === 'function' && !matcher(threw)) throw new Error(`${msg || '异常不满足条件'}：${threw.message}`);
  }
  return threw;
}

// ---------- 临时目录 ----------

const tmpRoots = [];
function makeTmpDir(tag = 'vb-test') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  tmpRoots.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of tmpRoots.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------- MCP 客户端模拟器 ----------

class MCPClient {
  constructor(opts = {}) {
    this.env = {
      ...process.env,
      VISION_API_KEY: '',
      VISION_CACHE: 'off',
      VISION_LOG: 'off',
      ...(opts.env || {}),
    };
    this.args = opts.args || [];
    this.id = 0;
    this.pending = new Map();
    this.unsolicited = [];
    this.badLines = [];
    this.stderr = '';
    this.exited = null;
    this.child = null;
  }

  start() {
    this.child = spawn(process.execPath, [...this.args, SERVER], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('exit', (code, sig) => {
      this.exited = { code, sig };
      for (const [, p] of this.pending) p.reject(new Error(`服务器进程已退出（code=${code} sig=${sig}）`));
      this.pending.clear();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => (this.stderr += d));

    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // stdout 必须是纯 JSON-RPC，出现别的东西就是 bug
          this.badLines.push(line);
          continue;
        }
        const list = Array.isArray(msg) ? msg : [msg];
        for (const m of list) {
          const p = m && m.id !== undefined && m.id !== null ? this.pending.get(m.id) : null;
          if (p) {
            this.pending.delete(m.id);
            p.resolve(m);
          } else {
            this.unsolicited.push(m);
          }
        }
      }
    });
    return this;
  }

  /** 返回整条响应报文（不抛错），调用方自己断言 result / error */
  request(method, params, timeoutMs = 15000) {
    const id = ++this.id;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(msg);
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  /** 原样发送（用来测试畸形报文） */
  writeRaw(text) {
    this.child.stdin.write(text.endsWith('\n') ? text : text + '\n');
  }

  write(obj) {
    this.writeRaw(JSON.stringify(obj));
  }

  async handshake(protocolVersion = '2024-11-05') {
    const res = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'vision-bridge-test', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return res;
  }

  /** 等 ms 毫秒，返回这段时间内收到的“无主”报文（用于验证通知不该有响应） */
  async collectUnsolicited(ms = 400) {
    const before = this.unsolicited.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.unsolicited.slice(before);
  }

  stop() {
    if (this.child && this.exited === null) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------- 读取真实配置（live 测试用，缺就返回 null，绝不抛） ----------

function loadLiveEnv() {
  const fromProcess = process.env.VISION_API_KEY
    ? {
        VISION_API_KEY: process.env.VISION_API_KEY,
        VISION_API_BASE: process.env.VISION_API_BASE || '',
        VISION_MODEL: process.env.VISION_MODEL || '',
        VISION_API_STYLE: process.env.VISION_API_STYLE || '',
      }
    : null;
  if (fromProcess) return fromProcess;
  try {
    const cfgPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg && cfg.mcp && cfg.mcp.servers && cfg.mcp.servers['vision-bridge'] && cfg.mcp.servers['vision-bridge'].env;
    if (env && env.VISION_API_KEY && !/^<.*>$/.test(env.VISION_API_KEY)) return { ...env };
  } catch {
    /* 没有配置文件 / 格式不对，都当作没有 */
  }
  return null;
}

module.exports = { Suite, suite, assertIncludes, assertNotIncludes, assertThrows, makeTmpDir, cleanupTmp, MCPClient, loadLiveEnv, SERVER };

#!/usr/bin/env node
/**
 * Vision Bridge MCP Server
 * 为纯文本模型（如 DeepSeek）提供识图能力：把图片交给外部多模态 API 转成文字，主模型继续推理与编码。
 *
 * 零依赖：只用 Node.js 内置模块，stdio JSON-RPC 传输。
 * 配置项见 README「可配置项」一节，或直接跑 `node server.js --doctor`。
 *
 * 协议要点（踩过的坑，别改回去）：
 *  - 业务失败（图片不存在 / API 429）返回 result.isError=true，只有协议级问题才用 JSON-RPC error，
 *    否则部分客户端会当成服务器故障直接掐断，模型也看不到错误文本，没法自己换路径重试。
 *  - 通知类消息（notifications/*、无 id 的请求）一律不回包，回了带 undefined/null id 就是非法报文。
 *  - stdout 只能写 JSON-RPC，任何人类可读输出都走 stderr。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { config, snapshot } = require('./lib/config');
const { Logger } = require('./lib/log');
const { ResultCache } = require('./lib/cache');
const { VisionError } = require('./lib/errors');
const { Semaphore, isLocalBase } = require('./lib/vision');
const toolsLib = require('./lib/tools');

// ---------- 版本 ----------

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  } catch {
    return { name: 'vision-bridge', version: '0.0.0-unknown' };
  }
}
const PKG = readPkg();

/** 我们能处理的 MCP 协议版本，优先沿用客户端要求的那个 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PREFERRED_PROTOCOL = '2025-06-18';

// ---------- 运行时 ----------

const log = new Logger(config);
const cache = new ResultCache(config, log);
const semaphore = new Semaphore(config.maxConcurrent);
const inflight = new Map(); // requestId -> AbortController
let fatalCount = 0;

// ================= CLI 模式 =================

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `
vision-bridge ${PKG.version} —— 给纯文本模型加识图能力的 MCP 服务器

不带参数启动 = MCP stdio 服务器模式（由客户端拉起，不要手动跑着等输出）。

调试用子命令：
  --help                 显示本帮助
  --version              显示版本
  --tools                列出所有工具及其参数
  --doctor               打印生效配置（Key 已打码）、缓存与日志状态、代理可用性
  --ping                 用内置生成的测试图真调一次视觉 API，验证 Key/模型/网络是否通
  --clear-cache          清空结果缓存
  --call <tool>          直接调用某个工具，例如：
                           node server.js --call ocr_image --image D:/a.png
                           node server.js --call analyze_image --image latest --prompt "这是什么报错"
    --image <路径|latest|URL>   可重复多次传多张图
    --prompt <文本>             追加提示词
    --json                      输出完整 JSON（含 usage / 缓存状态）

工具：${toolsLib.TOOLS.map((t) => t.name).join(', ')}
`.trimStart();

async function runCli(args) {
  if (args.flags.help || args.flags.h) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.flags.version || args.flags.v) {
    process.stdout.write(`${PKG.name} ${PKG.version}\n`);
    return 0;
  }
  if (args.flags.tools) {
    for (const t of toolsLib.listTools()) {
      process.stdout.write(`\n● ${t.name} —— ${t.title}\n  ${t.description}\n  参数: ${Object.keys(t.inputSchema.properties).join(', ')}\n`);
    }
    return 0;
  }
  if (args.flags['clear-cache']) {
    const n = cache.clear();
    process.stdout.write(`已清空缓存：删除 ${n} 个文件（${config.cacheDir}）\n`);
    return 0;
  }
  if (args.flags.doctor) {
    const snap = snapshot();
    process.stdout.write(`vision-bridge ${PKG.version}  (node ${process.version})\n\n`);
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n\n');
    process.stdout.write(`缓存统计: ${JSON.stringify(cache.stats())}\n`);
    if (config.warnings.length) process.stdout.write(`\n注意:\n${config.warnings.map((w) => '  - ' + w).join('\n')}\n`);
    const noKey = config.candidates.every((c) => !c.apiKey && !isLocalBase(c.apiBase));
    if (noKey) process.stdout.write('\n✗ 没有可用的 API Key，识图会直接失败。请设置 VISION_API_KEY。\n');
    else process.stdout.write('\n✓ 配置看起来完整，可以用 --ping 真调一次验证连通性。\n');
    return noKey ? 1 : 0;
  }
  if (args.flags.ping) {
    const { makeTwoTonePng } = require('./lib/pngwriter');
    const tmp = path.join(require('os').tmpdir(), `vision-bridge-ping-${process.pid}.png`);
    fs.writeFileSync(tmp, makeTwoTonePng(96));
    process.stdout.write(`测试图: ${tmp}（左半红 / 右半蓝）\n模型: ${config.candidates.map((c) => c.model).join(' → ')}\n\n`);
    try {
      const res = await toolsLib.runTool('analyze_image', { image_path: tmp, prompt: '这张图分成左右两半，各是什么颜色？只用一句话回答。' }, ctx());
      process.stdout.write(res.content[0].text + '\n');
      const sc = res.structuredContent;
      process.stdout.write(`\n${/红|red/i.test(sc.text) && /蓝|blue/i.test(sc.text) ? '✓ 视觉链路正常（颜色答对了）' : '⚠ 调用成功但回答不含预期颜色，模型质量可能有问题'}\n`);
      return 0;
    } catch (e) {
      process.stdout.write(`✗ 调用失败\n\n${e instanceof VisionError ? e.toToolText() : e.stack || e.message}\n`);
      return 1;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
  if (args.flags.call) {
    const name = String(args.flags.call);
    const images = [];
    // --image 可以出现多次，parseArgv 只保留最后一个，这里从原始 argv 重扫
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--image' && argv[i + 1]) images.push(argv[++i]);
    if (!images.length) {
      process.stderr.write('缺少 --image 参数\n');
      return 2;
    }
    const toolArgs = images.length > 1 ? { image_paths: images } : { image_path: images[0] };
    if (typeof args.flags.prompt === 'string') toolArgs.prompt = args.flags.prompt;
    try {
      const res = await toolsLib.runTool(name, toolArgs, ctx());
      process.stdout.write(args.flags.json ? JSON.stringify(res, null, 2) + '\n' : res.content[0].text + '\n');
      return 0;
    } catch (e) {
      process.stdout.write((e instanceof VisionError ? e.toToolText() : `失败：${e.message}`) + '\n');
      return 1;
    }
  }
  return null; // 不是 CLI 请求 → 进 MCP 服务器模式
}

function ctx(signal) {
  return { config, log, cache, semaphore, signal };
}

// ================= MCP 服务器模式 =================

function send(obj) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch (e) {
    log.error('响应序列化失败', { err: e.message });
    return;
  }
  try {
    process.stdout.write(s + '\n');
  } catch (e) {
    log.error('写 stdout 失败', { err: e.message });
  }
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

/** 业务失败 → isError 结果（模型能看到文字，可以自己改参数重试） */
function toolErrorResult(e, toolName) {
  const isVision = e instanceof VisionError;
  if (!isVision) {
    log.error(`工具 ${toolName} 内部异常`, { err: e && e.message });
    log.trace('内部异常堆栈', { stack: (e && e.stack) || String(e) });
  } else {
    log.warn(`工具 ${toolName} 失败`, { code: e.code, status: e.status, msg: e.message });
  }
  const text = isVision
    ? e.toToolText()
    : `识图工具内部异常：${(e && e.message) || String(e)}\n\n下一步：这不是图片本身的问题，可以原样重试一次；若持续失败请让用户查看 ${config.logDir} 下的日志。`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: {
      error: {
        code: isVision ? e.code : 'internal_error',
        message: (e && e.message) || String(e),
        hint: isVision ? e.hint : undefined,
        status: isVision ? e.status : undefined,
      },
    },
  };
}

function handleNotification(method, params) {
  if (method === 'notifications/cancelled') {
    const id = params && params.requestId;
    const entry = inflight.get(id);
    if (!entry) return;
    entry.cancelled = true;
    if (config.cancelMode === 'abort') {
      entry.ac.abort();
      inflight.delete(id);
      log.info('客户端取消了请求，已中止在途的视觉 API 调用', { requestId: String(id), reason: params && params.reason });
    } else {
      // 客户端的工具超时往往比视觉模型还短（ZCode 硬编码 30s）。这里让上游继续跑完并写进缓存，
      // 模型原样重试时会命中缓存/合并到这次调用，而不是又开一个同样慢的请求。
      log.info('客户端取消了请求；上游调用继续跑完并写入缓存，重试会直接命中', {
        requestId: String(id),
        tool: entry.name,
        reason: params && params.reason,
      });
    }
    return;
  }
  log.trace('收到通知', { method });
}

async function route(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;

  // 客户端发来的响应（我们没主动请求，但有些客户端会回 ping），忽略
  if (msg.result !== undefined || msg.error !== undefined) return null;

  const method = typeof msg.method === 'string' ? msg.method : '';
  const isNotification = msg.id === undefined || msg.id === null;

  if (!method) return isNotification ? null : err(msg.id, -32600, 'Invalid Request：缺少 method 字段');

  // 通知不回包
  if (isNotification || method.startsWith('notifications/')) {
    handleNotification(method, msg.params);
    return null;
  }

  switch (method) {
    case 'initialize': {
      const want = msg.params && msg.params.protocolVersion;
      const version = SUPPORTED_PROTOCOLS.includes(want) ? want : PREFERRED_PROTOCOL;
      const client = (msg.params && msg.params.clientInfo) || {};
      log.info('客户端已连接', { client: `${client.name || '?'}/${client.version || '?'}`, protocol: version });
      return ok(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vision-bridge', title: 'Vision Bridge（识图桥）', version: PKG.version },
        instructions:
          '本服务器把图片交给外部视觉模型转成文字。用户提到截图/图片/设计稿/报错图时请主动调用：' +
          '读文字用 ocr_image，看报错用 read_error_screenshot，还原界面用 describe_ui，多图对比用 compare_images，其它情况用 analyze_image。' +
          '图片是用户刚粘贴到对话里的（没给路径）时，传 image_path="latest"。',
      });
    }

    case 'ping':
      return ok(msg.id, {});

    case 'tools/list':
      return ok(msg.id, { tools: toolsLib.listTools() });

    case 'tools/call': {
      const params = msg.params || {};
      if (typeof params.name !== 'string' || !params.name) {
        return err(msg.id, -32602, 'tools/call 缺少 name 参数');
      }
      const entry = { ac: new AbortController(), cancelled: false, name: params.name };
      inflight.set(msg.id, entry);
      try {
        const result = await toolsLib.runTool(params.name, params.arguments, ctx(entry.ac.signal));
        // 客户端已经放弃这个请求了，按协议不再回包（结果此时已进缓存）
        if (entry.cancelled) {
          log.info('已取消的请求跑完了，结果已写入缓存', { requestId: String(msg.id), tool: params.name });
          return null;
        }
        return ok(msg.id, result);
      } catch (e) {
        if (entry.cancelled) {
          log.info('已取消的请求最终失败，不回包', { requestId: String(msg.id), err: (e && e.message) || String(e) });
          return null;
        }
        return ok(msg.id, toolErrorResult(e, params.name));
      } finally {
        inflight.delete(msg.id);
      }
    }

    // 没声明这些能力，但个别客户端仍会问一嘴；回空列表比回错误安静
    case 'resources/list':
      return ok(msg.id, { resources: [] });
    case 'resources/templates/list':
      return ok(msg.id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(msg.id, { prompts: [] });

    case 'logging/setLevel': {
      const level = msg.params && msg.params.level;
      const map = { debug: 'debug', info: 'info', notice: 'info', warning: 'warn', error: 'error', critical: 'error', alert: 'error', emergency: 'error' };
      if (map[level]) log.threshold = require('./lib/log').LEVELS[map[level]];
      return ok(msg.id, {});
    }

    default:
      return err(msg.id, -32601, `Method not found: ${method}`);
  }
}

function dispatch(msg) {
  // 不 await：视觉调用要好几秒，期间还得能处理 cancel / ping
  Promise.resolve()
    .then(() => route(msg))
    .then((res) => {
      if (res) send(res);
    })
    .catch((e) => {
      log.error('请求处理异常', { err: (e && e.message) || String(e) });
      log.trace('请求处理异常堆栈', { stack: (e && e.stack) || '' });
      if (msg && msg.id !== undefined && msg.id !== null) {
        send(err(msg.id, -32603, `Internal error: ${(e && e.message) || String(e)}`));
      }
    });
}

function onLine(line) {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    log.warn('收到无法解析的 JSON，已忽略', { head: s.slice(0, 120) });
    send(err(null, -32700, `Parse error: ${e.message}`));
    return;
  }
  if (Array.isArray(msg)) {
    // 批量请求（2025-03-26 协议）：响应也要打包成数组
    Promise.all(msg.map((m) => route(m).catch(() => null)))
      .then((rs) => {
        const out = rs.filter(Boolean);
        if (out.length) send(out);
      })
      .catch(() => {});
    return;
  }
  dispatch(msg);
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of inflight.values()) {
    try {
      entry.ac.abort(); // 进程要退了，在途请求没有意义了
    } catch {
      /* ignore */
    }
  }
  log.close();
  process.exit(code);
}

function installGuards() {
  // 任何一次意外抛错都不能带走整个进程 —— 否则本次会话之后所有识图调用都会失败，
  // 而用户只会看到「工具不可用」，完全不知道发生了什么。
  process.on('uncaughtException', (e) => {
    fatalCount++;
    log.error(`未捕获异常（第 ${fatalCount} 次，进程继续运行）`, { err: (e && e.message) || String(e) });
    log.trace('未捕获异常堆栈', { stack: (e && e.stack) || '' });
    if (fatalCount > 20) {
      log.error('异常次数过多，进程退出，请让客户端重连');
      shutdown(1);
    }
  });
  process.on('unhandledRejection', (r) => {
    fatalCount++;
    log.error(`未处理的 Promise 拒绝（第 ${fatalCount} 次，进程继续运行）`, { err: (r && r.message) || String(r) });
    log.trace('未处理拒绝堆栈', { stack: (r && r.stack) || '' });
  });
  process.stdout.on('error', () => shutdown(0)); // 客户端关掉管道（EPIPE）
  process.stdin.on('error', (e) => {
    log.warn('stdin 错误，退出', { err: e.message });
    shutdown(0);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        log.info(`收到 ${sig}，退出`);
        shutdown(0);
      });
    } catch {
      /* 平台不支持该信号 */
    }
  }
}

function startServer() {
  installGuards();

  for (const w of config.warnings) log.warn(w);
  const noKey = config.candidates.every((c) => !c.apiKey && !isLocalBase(c.apiBase));
  if (noKey) log.warn('未设置 VISION_API_KEY，识图调用会失败（智谱 open.bigmodel.cn 的 glm-4v-flash 有免费额度）');

  log.info(
    `已启动 v${PKG.version}`,
    {
      model: config.candidates.map((c) => c.model).join('→'),
      style: config.apiStyle,
      base: config.apiBase,
      maxTokens: config.maxTokens,
      cache: config.cacheMode,
      tools: toolsLib.TOOLS.length,
    }
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', onLine);
  rl.on('close', () => {
    log.info('stdin 已关闭，正常退出');
    shutdown(0);
  });
}

// ================= 入口 =================

(async () => {
  const args = parseArgv(process.argv.slice(2));
  const hasCliFlag = ['help', 'h', 'version', 'v', 'tools', 'doctor', 'ping', 'clear-cache', 'call'].some((k) => k in args.flags);
  if (hasCliFlag) {
    let code = 1;
    try {
      code = await runCli(args);
    } catch (e) {
      process.stderr.write(`执行失败：${(e && e.stack) || e}\n`);
      code = 1;
    }
    log.close();
    process.exit(code === null ? 0 : code);
  }
  startServer();
})();

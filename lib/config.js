'use strict';

/**
 * 配置解析：全部来自环境变量，解析一次后冻结。
 * 任何解析问题都收集到 warnings 里，由 server.js 启动时打到 stderr（不能污染 stdout）。
 */

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.zcode', 'vision-bridge');
const KNOWN_STYLES = new Set(['openai', 'gemini-native']);

const warnings = [];
function warn(msg) {
  warnings.push(msg);
}

// ---------- env 读取原语 ----------

function raw(name) {
  const v = process.env[name];
  return v === undefined || v === null ? undefined : String(v).trim();
}

function str(name, dflt) {
  const v = raw(name);
  return v === undefined || v === '' ? dflt : v;
}

function int(name, dflt, min, max) {
  const v = raw(name);
  if (v === undefined || v === '') return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    warn(`${name}="${v}" 不是整数，已回退默认值 ${dflt}`);
    return dflt;
  }
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function num(name, dflt) {
  const v = raw(name);
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    warn(`${name}="${v}" 不是数字，已忽略`);
    return dflt;
  }
  return n;
}

function bool(name, dflt) {
  const v = raw(name);
  if (v === undefined || v === '') return dflt;
  const s = v.toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
  warn(`${name}="${v}" 不是布尔值，已回退默认值 ${dflt}`);
  return dflt;
}

/** 解析 JSON 对象型环境变量，坏了只告警不崩 */
function jsonObj(name, dflt) {
  const v = raw(name);
  if (v === undefined || v === '') return dflt;
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch (e) {
    warn(`${name} 不是合法 JSON，已忽略：${e.message}`);
    return dflt;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${name} 必须是 JSON 对象，已忽略`);
    return dflt;
  }
  return parsed;
}

/** 逗号/分号/换行分隔（不用冒号，Windows 盘符会误伤） */
function list(name, dflt) {
  const v = raw(name);
  if (v === undefined || v === '') return dflt || [];
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

// ---------- 视觉服务商候选链 ----------

/**
 * 推断 API 风格：Gemini 的 OpenAI 兼容端点默认开思考模式，长 OCR 会被截断，
 * 所以在用户没显式指定时自动切到原生 generateContent 端点。
 */
function inferStyle(base, explicit) {
  if (explicit && KNOWN_STYLES.has(explicit)) return explicit;
  if (/generativelanguage\.googleapis\.com/i.test(base)) return 'gemini-native';
  return 'openai';
}

/**
 * VISION_MODEL 支持逗号分隔的候选链，主模型失败自动降级：
 *   VISION_MODEL="glm-4v-flash,glm-4v-plus"
 * 每一项还可用 | 追加独立的 base / key / style（跨服务商降级）：
 *   VISION_MODEL="glm-4v-flash,qwen-vl-max|https://dashscope.aliyuncs.com/compatible-mode/v1|sk-xxx"
 * 更复杂的场景用 VISION_FALLBACKS（JSON 数组）。
 */
function parseCandidates(defaults) {
  const out = [];
  const seen = new Set();

  const push = (c, source) => {
    if (!c || !c.model) return;
    const key = `${c.apiStyle}|${c.apiBase}|${c.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    // 不校验 apiKey：本地 Ollama / vLLM 等无需 key
    out.push({ ...c, source });
  };

  for (const entry of list('VISION_MODEL', [defaults.model])) {
    const [model, base, key, style] = entry.split('|').map((s) => (s === undefined ? undefined : s.trim()));
    if (!model) continue;
    const apiBase = normBase(base || defaults.apiBase);
    push(
      {
        model,
        apiBase,
        // 写成 "model|base|" 时 key 是空字符串，表示显式不带 Key（本地 Ollama）；
        // 完全没写第三段才继承全局 Key
        apiKey: key !== undefined ? key : defaults.apiKey,
        apiStyle: inferStyle(apiBase, style || raw('VISION_API_STYLE')),
      },
      'VISION_MODEL'
    );
  }

  const fb = raw('VISION_FALLBACKS');
  if (fb) {
    let parsed = null;
    try {
      parsed = JSON.parse(fb);
    } catch (e) {
      warn(`VISION_FALLBACKS 不是合法 JSON，已忽略：${e.message}`);
    }
    if (parsed && !Array.isArray(parsed)) {
      warn('VISION_FALLBACKS 必须是 JSON 数组，已忽略');
      parsed = null;
    }
    for (const item of parsed || []) {
      if (!item || typeof item !== 'object' || !item.model) {
        warn('VISION_FALLBACKS 中有条目缺少 model 字段，已跳过');
        continue;
      }
      const apiBase = normBase(item.api_base || item.apiBase || defaults.apiBase);
      push(
        {
          model: String(item.model),
          apiBase,
          apiKey: item.api_key || item.apiKey || defaults.apiKey,
          apiStyle: inferStyle(apiBase, item.api_style || item.apiStyle),
        },
        'VISION_FALLBACKS'
      );
    }
  }

  if (!out.length) {
    push({ model: defaults.model, apiBase: defaults.apiBase, apiKey: defaults.apiKey, apiStyle: inferStyle(defaults.apiBase) }, 'default');
  }
  return out;
}

// ---------- 组装 ----------

const apiKey = str('VISION_API_KEY', '');
const apiBase = normBase(str('VISION_API_BASE', 'https://open.bigmodel.cn/api/paas/v4'));
const model = str('VISION_MODEL_DEFAULT', 'glm-4v-flash');

const candidates = parseCandidates({ apiKey, apiBase, model });

const cacheModeRaw = str('VISION_CACHE', 'disk').toLowerCase();
const cacheMode = ['disk', 'memory', 'off'].includes(cacheModeRaw) ? cacheModeRaw : 'disk';
if (cacheMode !== cacheModeRaw) warn(`VISION_CACHE="${cacheModeRaw}" 无效（可选 disk/memory/off），已回退 disk`);

const maxTokensFieldRaw = str('VISION_MAX_TOKENS_FIELD', 'auto').toLowerCase();
const maxTokensField = ['auto', 'max_tokens', 'max_completion_tokens'].includes(maxTokensFieldRaw)
  ? maxTokensFieldRaw
  : 'auto';
if (maxTokensField !== maxTokensFieldRaw) warn(`VISION_MAX_TOKENS_FIELD="${maxTokensFieldRaw}" 无效，已回退 auto`);

/** 相对路径 / 裸文件名的候选搜索目录 */
function defaultSearchDirs() {
  const dirs = [
    process.cwd(),
    HOME,
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Downloads'),
    path.join(HOME, 'Pictures'),
    path.join(HOME, 'Pictures', 'Screenshots'),
    path.join(HOME, 'OneDrive', 'Pictures', 'Screenshots'),
    path.join(HOME, 'OneDrive', '图片', '屏幕截图'),
    path.join(HOME, 'Pictures', '屏幕截图'),
    path.join(HOME, '桌面'),
  ];
  return dirs;
}

/** 客户端粘贴图片的落盘目录（ZCode CLI 把对话里粘贴的图片写在这里） */
function defaultPasteDirs() {
  return [path.join(HOME, '.zcode', 'cli', 'image-cache')];
}

const config = {
  // 服务商
  apiKey,
  apiBase,
  model: candidates[0].model,
  apiStyle: candidates[0].apiStyle,
  candidates,

  // 生成参数
  maxTokens: int('VISION_MAX_TOKENS', 4096, 64, 200000),
  maxTokensField,
  temperature: (() => {
    const v = raw('VISION_TEMPERATURE');
    return v === undefined || v === '' ? undefined : num('VISION_TEMPERATURE', undefined);
  })(),
  // 经中转站用 Gemini/推理型模型时，用来关掉思考模式（思考会吃光输出预算导致返回空或截断）。
  // 服务商不认这个字段时会自动去掉并记住，不会因此失败。
  reasoningEffort: str('VISION_REASONING_EFFORT', ''),
  // 任意额外请求体字段，深合并进请求体，同名叶子以这里为准。
  // 例：{"extra_body":{"google":{"thinking_config":{"thinking_budget":0}}}}
  extraBody: jsonObj('VISION_EXTRA_BODY', {}),

  // 图片
  maxImageMB: num('VISION_MAX_IMAGE_MB', 5),
  maxImages: int('VISION_MAX_IMAGES', 8, 1, 32),
  searchDirs: [...list('VISION_BASE_DIR', []), ...list('VISION_SEARCH_DIRS', []), ...defaultSearchDirs()],
  pasteDirs: list('VISION_PASTE_DIRS', defaultPasteDirs()),
  allowedDirs: list('VISION_ALLOWED_DIRS', []),

  // 网络
  timeoutMs: int('VISION_TIMEOUT_MS', 120000, 1000),
  retries: int('VISION_RETRIES', 3, 1, 10),
  retryBaseMs: int('VISION_RETRY_BASE_MS', 500, 50, 30000),
  retryMaxWaitMs: int('VISION_RETRY_MAX_WAIT_MS', 20000, 1000, 120000),
  maxConcurrent: int('VISION_MAX_CONCURRENT', 2, 1, 16),

  // 缓存
  cacheMode,
  cacheDir: str('VISION_CACHE_DIR', path.join(STATE_DIR, 'cache')),
  cacheTtlMs: int('VISION_CACHE_TTL_HOURS', 168, 1) * 3600 * 1000,
  cacheMaxEntries: int('VISION_CACHE_MAX', 300, 1),

  // 日志
  logEnabled: bool('VISION_LOG', true),
  logDir: str('VISION_LOG_DIR', path.join(STATE_DIR, 'logs')),
  logKeepDays: int('VISION_LOG_KEEP_DAYS', 14, 1),
  logLevel: str('VISION_LOG_LEVEL', 'info').toLowerCase(),

  // 输出
  showMeta: bool('VISION_SHOW_META', true),

  // 客户端取消请求时怎么办。
  // detach（默认）：不中断上游调用，让它跑完并写入缓存 —— 客户端的工具超时（ZCode 是硬编码 30s）
  //   常常比视觉模型还短，中断了就等于白花钱，什么都留不下；跑完写缓存的话，模型再问一次就秒回。
  // abort：立刻中断，省一点点带宽（输入 token 其实已经付了）。
  cancelMode: ['detach', 'abort'].includes(str('VISION_CANCEL_MODE', 'detach')) ? str('VISION_CANCEL_MODE', 'detach') : 'detach',

  // 其它
  stateDir: STATE_DIR,
  home: HOME,
  warnings,
};

if (config.maxImageMB <= 0) {
  warn(`VISION_MAX_IMAGE_MB=${config.maxImageMB} 无效，已回退 5`);
  config.maxImageMB = 5;
}

if (candidates.length > 1) {
  warnings.push(
    `已启用降级链（共 ${candidates.length} 个候选）：` +
      candidates.map((c) => `${c.model}@${hostOf(c.apiBase)}`).join(' → ')
  );
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** 打码后的配置快照，用于 --doctor 和日志，永不泄露 key */
function snapshot() {
  const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}（${k.length} 字符）` : '（未设置）');
  return {
    api_key: mask(config.apiKey),
    candidates: config.candidates.map((c, i) => ({
      order: i + 1,
      model: c.model,
      api_base: c.apiBase,
      api_style: c.apiStyle,
      api_key: mask(c.apiKey),
      from: c.source,
    })),
    max_tokens: config.maxTokens,
    max_tokens_field: config.maxTokensField,
    temperature: config.temperature === undefined ? '（按工具默认）' : config.temperature,
    reasoning_effort: config.reasoningEffort || '（不发送）',
    extra_body: Object.keys(config.extraBody).length ? config.extraBody : '（无）',
    max_image_mb: config.maxImageMB,
    max_images: config.maxImages,
    timeout_ms: config.timeoutMs,
    retries: config.retries,
    max_concurrent: config.maxConcurrent,
    cache: config.cacheMode === 'off' ? 'off' : `${config.cacheMode}（${config.cacheDir}，TTL ${config.cacheTtlMs / 3600000}h，上限 ${config.cacheMaxEntries} 条）`,
    log: config.logEnabled ? `${config.logDir}（保留 ${config.logKeepDays} 天）` : 'off',
    allowed_dirs: config.allowedDirs.length ? config.allowedDirs : '（未限制，可读取本机任意文件）',
    paste_dirs: config.pasteDirs,
    search_dirs: config.searchDirs,
    proxy: {
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '（未设置）',
      env_proxy_enabled: proxyEnabled(),
    },
    node: process.version,
  };
}

/** Node 24+ 才有 --use-env-proxy / NODE_USE_ENV_PROXY，没开就不会走代理 */
function proxyEnabled() {
  return (
    process.execArgv.includes('--use-env-proxy') ||
    (process.env.NODE_OPTIONS || '').includes('--use-env-proxy') ||
    ['1', 'true', 'on', 'yes'].includes(String(process.env.NODE_USE_ENV_PROXY || '').toLowerCase())
  );
}

const hasProxyEnv = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
if (hasProxyEnv && !proxyEnabled()) {
  warn(
    '检测到 HTTPS_PROXY/HTTP_PROXY，但 Node 未启用环境代理：请给启动命令加 --use-env-proxy（Node ≥ 24）或设 NODE_USE_ENV_PROXY=1，否则请求不会走代理'
  );
}

module.exports = { config, snapshot, proxyEnabled, hostOf, KNOWN_STYLES, _internal: { normBase, inferStyle, parseCandidates, list, bool, int } };

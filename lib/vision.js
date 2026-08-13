'use strict';

/**
 * 视觉 API 调用层。
 * 三层防御，目的是“免费额度用完 / 网络抖一下”不要变成“识图功能挂了”：
 *   1. 同一候选内：指数退避重试（尊重 Retry-After），只重试真正可能恢复的错误
 *   2. 跨候选：VISION_MODEL 逗号分隔的降级链，可跨服务商
 *   3. 参数兼容：400 报 max_tokens/temperature 不认时，自动换字段/去参数再试一次并记住
 * 另外把 finish_reason=length（输出被截断）显式暴露出去 —— 不然模型会拿半截信息继续推理。
 */

const http = require('http');
const https = require('https');

const { VisionError } = require('./errors');

/** 这些状态码等一会儿可能就好了 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** 记住某个 base+model 的参数怪癖，避免每次都撞一次 400 */
const quirkMemory = new Map();

function quirksFor(candidate, config) {
  const key = `${candidate.apiBase}|${candidate.model}`;
  if (!quirkMemory.has(key)) {
    quirkMemory.set(key, {
      maxTokensField: config.maxTokensField === 'auto' ? 'max_tokens' : config.maxTokensField,
      fieldLocked: config.maxTokensField !== 'auto',
      noTemperature: false,
      noReasoningEffort: false,
    });
  }
  return quirkMemory.get(key);
}

// ---------- 并发闸门：模型一次丢 5 张图过来时别把自己打限流 ----------

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ---------- 底层 HTTP ----------

function httpJson({ url, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new VisionError(`API 地址不合法：${url}`, { code: 'bad_api_base', hint: '检查 VISION_API_BASE 是否是完整 URL（含 https:// 与 /v1 之类的路径前缀）。' }));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(body, 'utf8');
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': payload.length },
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`请求超过 ${Math.round(timeoutMs / 1000)}s 未完成`);
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.end(payload);
  });
}

// ---------- 请求体构造 ----------

function imagePart(img) {
  return { type: 'image_url', image_url: { url: img.dataUrl } };
}

/** 深合并：extra 里的叶子覆盖 base，对象递归（用于 VISION_EXTRA_BODY） */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function buildOpenAIRequest(candidate, images, prompt, maxTokens, temperature, quirks, extras) {
  const content = [{ type: 'text', text: prompt }];
  if (images.length === 1) {
    content.push(imagePart(images[0]));
  } else {
    images.forEach((img, i) => {
      content.push({ type: 'text', text: `【图${i + 1}】` });
      content.push(imagePart(img));
    });
  }
  const body = { model: candidate.model, messages: [{ role: 'user', content }], stream: false };
  body[quirks.maxTokensField] = maxTokens;
  if (temperature !== undefined && !quirks.noTemperature) body.temperature = temperature;
  const ex = extras || {};
  // 关思考模式（Gemini 3 / 推理型模型经中转站时最有用）
  if (ex.reasoningEffort && !quirks.noReasoningEffort) body.reasoning_effort = ex.reasoningEffort;
  deepMerge(body, ex.extraBody);
  return {
    url: `${candidate.apiBase}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // 本地 Ollama / vLLM 可以不配 key
      ...(candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function buildGeminiRequest(candidate, images, prompt, maxTokens, temperature, extras) {
  const parts = [{ text: prompt }];
  images.forEach((img, i) => {
    if (images.length > 1) parts.push({ text: `【图${i + 1}】` });
    if (img.kind === 'url') {
      // 原生端点不收远程 URL，这种情况调用方应改用 openai 风格
      throw new VisionError('gemini-native 风格不支持 image_url（远程图片）', {
        code: 'style_unsupported',
        hint: '把图片下载到本地后用 image_path，或把 VISION_API_STYLE 设为 openai。',
      });
    }
    parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
  });
  const generationConfig = {
    // Gemini 的思考模式会吃掉输出预算导致长 OCR 被截断，这里显式关掉
    thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    maxOutputTokens: maxTokens,
  };
  if (temperature !== undefined) generationConfig.temperature = temperature;

  // VISION_API_BASE 允许填 OpenAI 兼容端点（带 /openai 后缀），原生接口在 /v1beta 下
  const base = candidate.apiBase.replace(/\/openai\/?$/, '');
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  deepMerge(body, extras && extras.extraBody);
  return {
    url: `${base}/models/${encodeURIComponent(candidate.model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-goog-api-key': candidate.apiKey },
    body: JSON.stringify(body),
  };
}

// ---------- 响应解析 ----------

function parseOpenAIResponse(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new VisionError(`视觉 API 返回的不是 JSON：${raw.slice(0, 200)}`, {
      code: 'bad_response',
      hint: '检查 VISION_API_BASE 是不是指到了网页或代理错误页（常见于漏写 /v1）。',
    });
  }
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p && p.text ? p.text : '')).join('');
  if (!text && typeof msg.reasoning_content === 'string') text = msg.reasoning_content; // 思考模式服务商的兜底
  const finish = choice.finish_reason || choice.finishReason || '';
  return {
    text: typeof text === 'string' ? text : '',
    finish,
    truncated: finish === 'length' || finish === 'max_tokens',
    usage: normalizeUsage(j.usage),
    raw: j,
  };
}

function parseGeminiResponse(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new VisionError(`视觉 API 返回的不是 JSON：${raw.slice(0, 200)}`, { code: 'bad_response' });
  }
  const block = j.promptFeedback && j.promptFeedback.blockReason;
  if (block) {
    throw new VisionError(`图片被安全策略拦截（${block}）`, {
      code: 'blocked',
      hint: '这张图触发了服务商的内容策略，换一张图或换一个服务商（VISION_MODEL 降级链）。',
    });
  }
  const cand = (j.candidates && j.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('\n');
  const finish = cand.finishReason || '';
  if (!text && finish === 'SAFETY') {
    throw new VisionError('输出被安全策略拦截（SAFETY）', { code: 'blocked', hint: '换一张图或换服务商。' });
  }
  const um = j.usageMetadata || {};
  return {
    text,
    finish,
    truncated: finish === 'MAX_TOKENS',
    usage: normalizeUsage({
      prompt_tokens: um.promptTokenCount,
      completion_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
      total_tokens: um.totalTokenCount,
    }),
    raw: j,
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const inTok = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens;
  const outTok = u.completion_tokens ?? u.output_tokens ?? u.completionTokens;
  const total = u.total_tokens ?? u.totalTokens ?? (Number(inTok || 0) + Number(outTok || 0) || undefined);
  if (inTok === undefined && outTok === undefined && total === undefined) return null;
  return { in: num(inTok), out: num(outTok), total: num(total) };
  function num(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  }
}

// ---------- 错误翻译（给模型看的中文 + 可执行建议） ----------

const STATUS_HINTS = {
  400: '服务商拒绝了请求参数。常见原因：模型不支持图片输入、图片格式不被接受、或 max_tokens/temperature 字段不兼容。',
  401: 'API Key 无效或已过期，请检查 VISION_API_KEY。',
  402: '账户余额不足，请充值或换用免费模型（如智谱 glm-4v-flash）。',
  403: 'Key 没有该模型的权限，或触发了风控。确认已在服务商后台开通 VISION_MODEL 对应的模型。',
  404: '接口路径或模型名不存在。检查 VISION_API_BASE（是否漏了 /v1 之类前缀）与 VISION_MODEL 拼写。',
  413: '请求体过大：图片太大。压缩图片或调低 VISION_MAX_IMAGE_MB。',
  415: '不支持的图片格式，请转成 PNG 或 JPEG。',
  422: '请求参数校验失败，检查模型名与参数是否匹配。',
  429: '被限流或免费额度用尽（已自动重试）。可在 VISION_MODEL 里配置逗号分隔的备用模型自动降级。',
  500: '服务商内部错误（已自动重试）。',
  502: '网关错误（已自动重试），常见于代理不稳定。',
  503: '服务暂时不可用（已自动重试）。',
  504: '服务商网关超时（已自动重试）。',
};

function extractApiMessage(raw) {
  try {
    const j = JSON.parse(raw);
    const e = j.error || j;
    const m =
      (typeof e === 'string' ? e : '') ||
      e.message ||
      e.msg ||
      e.error_msg ||
      (e.metadata && e.metadata.raw) ||
      j.message ||
      j.msg ||
      '';
    if (m) return String(m).replace(/\s+/g, ' ').slice(0, 400);
  } catch {
    /* 不是 JSON，退回原文 */
  }
  return String(raw || '').replace(/\s+/g, ' ').slice(0, 300);
}

function networkHint(err, candidate) {
  const code = err && err.code;
  if (code === 'ENOTFOUND') return `域名解析失败（${hostOf(candidate.apiBase)}）。检查网络、VISION_API_BASE 拼写，或代理是否需要开启。`;
  if (code === 'ECONNREFUSED')
    return `连接被拒绝（${hostOf(candidate.apiBase)}）。如果用的是本地模型（Ollama / vLLM），确认服务已启动且端口正确。`;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return '请求超时。图片较大或网络较慢，可调高 VISION_TIMEOUT_MS，或压缩图片。';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被重置，通常是代理不稳定。已自动重试，可检查 HTTPS_PROXY 是否可用。';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || String(err && err.message).includes('certificate'))
    return 'TLS 证书校验失败，通常是代理中间人。确认代理配置正确。';
  if (code === 'ERR_PROXY_TUNNEL' || String(err && err.message).includes('tunneling'))
    return '代理隧道建立失败，检查 HTTPS_PROXY 地址与端口。';
  return '网络请求失败。检查网络/代理配置（Node ≥24 需要 --use-env-proxy 才会读 HTTPS_PROXY）。';
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** 本地推理服务（Ollama / vLLM / LM Studio）不需要 API Key */
function isLocalBase(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:|\/|$)/i.test(String(base || ''));
}

function parseRetryAfter(headers) {
  const v = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 主流程 ----------

/**
 * 依次尝试所有候选（每个候选内部带退避重试），返回第一个成功的结果。
 * 全部失败时抛 VisionError，message 里说清“试过谁、各自为什么失败”。
 */
async function callVision(opts) {
  const { images, prompt, config, log, semaphore } = opts;
  const maxTokens = opts.maxTokens || config.maxTokens;
  const temperature = config.temperature !== undefined ? config.temperature : opts.temperature;
  const signal = opts.signal;
  const started = Date.now();
  const failures = [];
  const notes = [];

  for (let ci = 0; ci < config.candidates.length; ci++) {
    const candidate = config.candidates[ci];
    const isLast = ci === config.candidates.length - 1;

    if (!candidate.apiKey && !isLocalBase(candidate.apiBase)) {
      failures.push({
        candidate,
        reason: '未配置 API Key',
        hint: '在 MCP 配置的 env 里设置 VISION_API_KEY（智谱 open.bigmodel.cn 的 GLM-4V-Flash 有免费额度）；本地 Ollama 之类不需要 Key。',
      });
      continue;
    }

    const quirks = quirksFor(candidate, config);
    let attempt = 0;
    let compatRetries = 0;

    while (attempt < config.retries) {
      attempt++;
      if (signal && signal.aborted) throw new VisionError('请求已被客户端取消', { code: 'cancelled' });

      const extras = { reasoningEffort: config.reasoningEffort, extraBody: config.extraBody };
      let built;
      try {
        built =
          candidate.apiStyle === 'gemini-native'
            ? buildGeminiRequest(candidate, images, prompt, maxTokens, temperature, extras)
            : buildOpenAIRequest(candidate, images, prompt, maxTokens, temperature, quirks, extras);
      } catch (e) {
        failures.push({ candidate, reason: e.message });
        break; // 请求都构造不出来，重试无意义
      }

      const t0 = Date.now();
      let res;
      try {
        res = await semaphore.run(() =>
          httpJson({ url: built.url, headers: built.headers, body: built.body, timeoutMs: config.timeoutMs, signal })
        );
      } catch (e) {
        if (e instanceof VisionError) throw e;
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
          throw new VisionError('请求已被客户端取消', { code: 'cancelled' });
        }
        const ms = Date.now() - t0;
        const retryable = RETRYABLE_CODES.has(e.code) || /socket hang up|timeout|premature close/i.test(e.message || '');
        log.trace('网络错误', { model: candidate.model, host: hostOf(candidate.apiBase), attempt, ms, code: e.code, msg: e.message });
        if (retryable && attempt < config.retries) {
          const wait = backoff(attempt, config);
          notes.push(`网络错误（${e.code || e.message}），${wait}ms 后第 ${attempt + 1} 次重试`);
          await sleep(wait);
          continue;
        }
        failures.push({ candidate, reason: `${e.code || 'network'}: ${e.message}`, hint: networkHint(e, candidate), attempts: attempt });
        break;
      }

      const ms = Date.now() - t0;

      // ---- 参数不兼容：换字段/去参数，立刻重试且不计入退避次数 ----
      if (res.status === 400 && candidate.apiStyle !== 'gemini-native' && compatRetries < 3) {
        const msg = extractApiMessage(res.body);
        if (/max_tokens/i.test(msg) && !quirks.fieldLocked && quirks.maxTokensField === 'max_tokens') {
          quirks.maxTokensField = 'max_completion_tokens';
          compatRetries++;
          attempt--;
          log.trace('参数兼容：改用 max_completion_tokens', { model: candidate.model, msg });
          notes.push('该模型不认 max_tokens，已自动改用 max_completion_tokens');
          continue;
        }
        if (/temperature/i.test(msg) && !quirks.noTemperature && temperature !== undefined) {
          quirks.noTemperature = true;
          compatRetries++;
          attempt--;
          log.trace('参数兼容：去掉 temperature', { model: candidate.model, msg });
          notes.push('该模型不接受 temperature，已自动去掉该参数');
          continue;
        }
        if (/reasoning_effort|reasoningEffort|thinking/i.test(msg) && !quirks.noReasoningEffort && config.reasoningEffort) {
          quirks.noReasoningEffort = true;
          compatRetries++;
          attempt--;
          log.trace('参数兼容：去掉 reasoning_effort', { model: candidate.model, msg });
          notes.push('该服务商不认 reasoning_effort，已自动去掉（若输出被思考吃光，请改用 VISION_EXTRA_BODY）');
          continue;
        }
      }

      if (res.status >= 400) {
        const apiMsg = extractApiMessage(res.body);
        const retryable = RETRYABLE_STATUS.has(res.status);
        log.trace('API 错误', { model: candidate.model, status: res.status, attempt, ms, msg: apiMsg });

        if (retryable && attempt < config.retries) {
          const ra = parseRetryAfter(res.headers);
          let wait = ra !== null ? ra : backoff(attempt, config);
          if (wait > config.retryMaxWaitMs) {
            // 让等这么久不如直接换下一个候选
            failures.push({
              candidate,
              status: res.status,
              reason: apiMsg,
              hint: `服务商要求等待 ${Math.round(wait / 1000)}s（超过上限 ${Math.round(config.retryMaxWaitMs / 1000)}s），已跳过该模型。`,
              attempts: attempt,
            });
            break;
          }
          notes.push(`${res.status} 错误，${wait}ms 后第 ${attempt + 1} 次重试`);
          await sleep(wait);
          continue;
        }

        failures.push({
          candidate,
          status: res.status,
          reason: apiMsg,
          hint: STATUS_HINTS[res.status] || `服务商返回 HTTP ${res.status}。`,
          attempts: attempt,
        });
        break;
      }

      // ---- 成功 ----
      const parsed = candidate.apiStyle === 'gemini-native' ? parseGeminiResponse(res.body) : parseOpenAIResponse(res.body);

      if (!parsed.text || !parsed.text.trim()) {
        const why = parsed.truncated
          ? `输出预算（${maxTokens} tokens）全被思考过程吃掉了，一个字都没留下`
          : `finish_reason=${parsed.finish || '未提供'}`;
        log.trace('空响应', { model: candidate.model, finish: parsed.finish, ms });
        if (!isLast) {
          failures.push({ candidate, reason: `返回内容为空（${why}）`, attempts: attempt });
          break;
        }
        throw new VisionError(`视觉模型 ${candidate.model} 返回了空内容（${why}）`, {
          code: 'empty_response',
          hint: parsed.truncated
            ? '调高 VISION_MAX_TOKENS，或换一个不带思考模式的视觉模型。'
            : '换一张更清晰的图片，或换一个模型（VISION_MODEL）再试。',
        });
      }

      return {
        text: parsed.text,
        truncated: parsed.truncated,
        finish: parsed.finish,
        usage: parsed.usage,
        model: candidate.model,
        apiBase: candidate.apiBase,
        apiStyle: candidate.apiStyle,
        host: hostOf(candidate.apiBase),
        attempts: attempt,
        candidateIndex: ci,
        fellBack: ci > 0,
        maxTokens,
        elapsedMs: Date.now() - started,
        requestMs: ms,
        notes,
        failures,
      };
    }

    if (!isLast) {
      const last = failures[failures.length - 1];
      log.warn(`候选 ${candidate.model} 失败，降级到下一个`, { reason: last && last.reason });
      notes.push(`${candidate.model} 失败，已降级到 ${config.candidates[ci + 1].model}`);
    }
  }

  // 全军覆没
  const lines = failures.map(
    (f) => `  · ${f.candidate.model}（${hostOf(f.candidate.apiBase)}）${f.status ? ' HTTP ' + f.status : ''}：${f.reason}`
  );
  const hint = failures.map((f) => f.hint).filter(Boolean)[0] || '检查 API Key、模型名与网络代理配置。';
  throw new VisionError(
    `所有 ${config.candidates.length} 个视觉模型候选都失败了：\n${lines.join('\n')}`,
    {
      code: 'all_candidates_failed',
      status: failures.length ? failures[failures.length - 1].status : undefined,
      hint:
        hint +
        (config.candidates.length === 1
          ? '\n提示：可以把 VISION_MODEL 写成逗号分隔的多个模型（例如 "glm-4v-flash,glm-4v-plus"），失败时自动降级。'
          : ''),
      details: { failures: failures.map((f) => ({ model: f.candidate.model, status: f.status, reason: f.reason })), elapsedMs: Date.now() - started },
    }
  );
}

function backoff(attempt, config) {
  const base = Math.min(config.retryMaxWaitMs, config.retryBaseMs * Math.pow(2, attempt - 1));
  return Math.round(base + Math.random() * 250);
}

module.exports = {
  callVision,
  Semaphore,
  isLocalBase,
  hostOf,
  deepMerge,
  buildOpenAIRequest,
  buildGeminiRequest,
  parseOpenAIResponse,
  parseGeminiResponse,
  normalizeUsage,
  extractApiMessage,
  parseRetryAfter,
  quirkMemory,
  RETRYABLE_STATUS,
  STATUS_HINTS,
};

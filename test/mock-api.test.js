'use strict';

/**
 * 端到端测试：起一个假的 OpenAI 兼容视觉 API，按 model 名返回不同的行为，
 * 用真实的 server.js 全链路跑一遍。不需要任何真 Key，也不烧额度。
 * 覆盖：重试、降级链、截断上报、缓存命中、参数兼容、请求体正确性。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { suite, assertIncludes, assertNotIncludes, makeTmpDir, cleanupTmp, MCPClient } = require('./harness');
const { makePng } = require('../lib/pngwriter');

const s = suite('端到端测试 (mock 视觉 API)');

const state = { reqs: [], counters: {} };
let server;
let port;
let TMP;
let PNG;
let PNG2;
const clients = [];

function reset() {
  state.reqs.length = 0;
  state.counters = {};
}

s.beforeAll(async () => {
  TMP = makeTmpDir('vb-mock');
  PNG = path.join(TMP, 'a.png');
  PNG2 = path.join(TMP, 'b.png');
  fs.writeFileSync(PNG, makePng(12, 12, [220, 38, 38]));
  fs.writeFileSync(PNG2, makePng(12, 12, [37, 99, 235]));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        /* 保持空对象 */
      }
      state.reqs.push({ url: req.url, headers: req.headers, body: j });
      const model = j.model || '';
      const n = (state.counters[model] = (state.counters[model] || 0) + 1);
      const send = (code, obj, headers) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...(headers || {}) });
        res.end(JSON.stringify(obj));
      };
      const okResp = (content, finish) =>
        send(200, {
          choices: [{ message: { content }, finish_reason: finish || 'stop' }],
          usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
        });

      switch (model) {
        case 'ok':
          return okResp('模拟识别结果：左边是红色，右边是蓝色。');
        case 'truncated':
          return okResp('这段内容只输出了一半', 'length');
        case 'flaky':
          return n < 2 ? send(429, { error: { message: '并发过高，请稍后重试' } }, { 'Retry-After': '0' }) : okResp('重试之后成功了');
        case 'dead':
          return send(500, { error: { message: 'internal boom' } });
        case 'unauthorized':
          return send(401, { error: { message: 'invalid api key' } });
        case 'picky':
          if ('max_tokens' in j) {
            return send(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
          }
          return okResp('换成 max_completion_tokens 之后成功');
        case 'blank':
          return okResp('');
        case 'no-effort':
          // 模拟不认 reasoning_effort 的中转站
          if ('reasoning_effort' in j) {
            return send(400, { error: { message: "Unrecognized request argument supplied: reasoning_effort" } });
          }
          return okResp('去掉 reasoning_effort 后成功');
        case 'slow':
          return setTimeout(() => okResp('慢模型终于返回了'), 1200);
        default:
          return send(404, { error: { message: 'model not found: ' + model } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

s.afterAll(async () => {
  for (const c of clients) c.stop();
  if (server) await new Promise((r) => server.close(r));
  cleanupTmp();
});

async function client(extraEnv) {
  const c = new MCPClient({
    env: {
      VISION_API_KEY: 'test-key',
      VISION_API_BASE: `http://127.0.0.1:${port}/v1`,
      VISION_API_STYLE: 'openai',
      VISION_RETRY_BASE_MS: '10',
      VISION_CACHE: 'off',
      VISION_LOG: 'off',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      NO_PROXY: '*',
      ...extraEnv,
    },
  }).start();
  clients.push(c);
  await c.handshake();
  return c;
}

const call = (c, name, args) => c.request('tools/call', { name, arguments: args }, 20000);
const textOf = (res) => {
  assert.ok(res.result, `期望 result，实际 ${JSON.stringify(res).slice(0, 300)}`);
  return res.result.content[0].text;
};

// ---------- 正常路径 ----------

s.test('识图成功：正文在最前面、溯源信息在末尾（前缀不再污染 OCR 结果）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const res = await call(c, 'ocr_image', { image_path: PNG });
  const text = textOf(res);
  assert.strictEqual(res.result.isError, undefined);
  assert.ok(text.startsWith('模拟识别结果'), `正文必须在最前面，实际开头：${text.slice(0, 60)}`);
  assertNotIncludes(text.split('\n')[0], '[vision-bridge]');
  const tail = text.slice(text.indexOf('———'));
  assertIncludes(tail, 'ok@127.0.0.1');
  assertIncludes(tail, 'tokens in 123 / out 45');
  assertIncludes(tail, 'a.png');
});

s.test('structuredContent 带上模型、用量、缓存状态与图片来源', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const res = await call(c, 'analyze_image', { image_path: PNG, prompt: '这是什么' });
  const sc = res.result.structuredContent;
  assert.strictEqual(sc.tool, 'analyze_image');
  assert.strictEqual(sc.model, 'ok');
  assert.strictEqual(sc.cached, false);
  assert.strictEqual(sc.truncated, false);
  assert.deepStrictEqual(sc.usage, { in: 123, out: 45, total: 168 });
  assert.strictEqual(sc.images.length, 1);
  assert.strictEqual(sc.images[0].mime, 'image/png');
  assert.strictEqual(sc.images[0].resolved_via, 'absolute');
});

s.test('请求体正确：base64 data URL + 默认 max_tokens=4096 + 内置 OCR 指令', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(state.reqs.length, 1);
  const r = state.reqs[0];
  assert.strictEqual(r.url, '/v1/chat/completions');
  assert.strictEqual(r.headers.authorization, 'Bearer test-key');
  assert.strictEqual(r.body.max_tokens, 4096, '默认必须是 4096，1024 会截断 OCR');
  assert.strictEqual(r.body.temperature, 0.01, 'OCR 应该用接近 0 的温度');
  const parts = r.body.messages[0].content;
  assertIncludes(parts[0].text, '逐字转录');
  assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
});

s.test('VISION_MAX_TOKENS 可配置', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok', VISION_MAX_TOKENS: '9000' });
  await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(state.reqs[0].body.max_tokens, 9000);
});

s.test('不同工具用不同温度（describe_ui 比 OCR 高）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  await call(c, 'describe_ui', { image_path: PNG });
  assert.strictEqual(state.reqs[0].body.temperature, 0.2);
  assertIncludes(state.reqs[0].body.messages[0].content[0].text, '组件清单');
});

// ---------- 截断 ----------

s.test('回归：finish_reason=length 时在返回文本最前面显式警告', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'truncated' });
  const res = await call(c, 'ocr_image', { image_path: PNG });
  const text = textOf(res);
  assert.ok(text.startsWith('⚠️'), `截断警告必须在最前面，实际：${text.slice(0, 80)}`);
  assertIncludes(text, '不完整');
  assertIncludes(text, 'VISION_MAX_TOKENS');
  assertIncludes(text, '这段内容只输出了一半', '正文仍要带回去');
  assert.strictEqual(res.result.structuredContent.truncated, true);
});

// ---------- 重试与降级 ----------

s.test('429 后自动退避重试并成功（不再一次性失败）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'flaky' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  assertIncludes(textOf(res), '重试之后成功了');
  assert.strictEqual(state.counters.flaky, 2, `期望重试 1 次共 2 个请求，实际 ${state.counters.flaky}`);
  assertIncludes(textOf(res), '重试 1 次');
});

s.test('主模型持续 5xx → 自动降级到备用模型', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'dead,ok', VISION_RETRIES: '2' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  assertIncludes(textOf(res), '模拟识别结果');
  assert.strictEqual(state.counters.dead, 2, 'dead 应重试 2 次');
  assert.strictEqual(state.counters.ok, 1);
  assertIncludes(textOf(res), '已降级到备用模型');
  assert.strictEqual(res.result.structuredContent.model, 'ok');
});

s.test('401 不做无意义重试，直接报 Key 问题', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'unauthorized' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  assert.strictEqual(res.result.isError, true);
  assert.strictEqual(state.counters.unauthorized, 1, '401 不应重试');
  const text = textOf(res);
  assertIncludes(text, 'invalid api key');
  assertIncludes(text, 'VISION_API_KEY');
});

s.test('全部候选失败时，报错里逐个说明谁为什么失败', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'dead,unauthorized', VISION_RETRIES: '1' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  const text = textOf(res);
  assert.strictEqual(res.result.isError, true);
  assertIncludes(text, 'dead');
  assertIncludes(text, 'unauthorized');
  assertIncludes(text, 'HTTP 500');
  assertIncludes(text, 'HTTP 401');
});

s.test('模型不认 max_tokens 时自动换成 max_completion_tokens', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'picky' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  assertIncludes(textOf(res), '换成 max_completion_tokens 之后成功');
  assert.strictEqual(state.counters.picky, 2);
  assert.ok('max_tokens' in state.reqs[0].body);
  assert.strictEqual(state.reqs[1].body.max_tokens, undefined);
  assert.strictEqual(state.reqs[1].body.max_completion_tokens, 4096);
});

s.test('VISION_REASONING_EFFORT 会发给服务商（关掉 Gemini 思考模式）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok', VISION_REASONING_EFFORT: 'none' });
  await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(state.reqs[0].body.reasoning_effort, 'none');
});

s.test('服务商不认 reasoning_effort 时自动去掉重试，不因此失败', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'no-effort', VISION_REASONING_EFFORT: 'none' });
  const res = await call(c, 'ocr_image', { image_path: PNG });
  assertIncludes(textOf(res), '去掉 reasoning_effort 后成功');
  assert.strictEqual(state.counters['no-effort'], 2);
  assert.strictEqual(state.reqs[1].body.reasoning_effort, undefined);
});

s.test('VISION_EXTRA_BODY 深合并进请求体', async () => {
  reset();
  const c = await client({
    VISION_MODEL: 'ok',
    VISION_EXTRA_BODY: '{"extra_body":{"google":{"thinking_config":{"thinking_budget":0}}}}',
  });
  await call(c, 'ocr_image', { image_path: PNG });
  const b = state.reqs[0].body;
  assert.strictEqual(b.extra_body.google.thinking_config.thinking_budget, 0);
  assert.strictEqual(b.max_tokens, 4096, '原有字段不能被抹掉');
});

s.test('模型返回空内容 → isError 而不是把空字符串当结果', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'blank' });
  const res = await call(c, 'analyze_image', { image_path: PNG });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(textOf(res), '空内容');
});

// ---------- 缓存 ----------

s.test('相同图片+提示词第二次直接命中缓存（不再重复上传与计费）', async () => {
  reset();
  const cacheDir = path.join(TMP, 'cache-e2e');
  const c = await client({ VISION_MODEL: 'ok', VISION_CACHE: 'disk', VISION_CACHE_DIR: cacheDir });
  const first = await call(c, 'ocr_image', { image_path: PNG });
  const second = await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(state.reqs.length, 1, `第二次不该再打 API，实际请求 ${state.reqs.length} 次`);
  assert.strictEqual(first.result.structuredContent.cached, false);
  assert.strictEqual(second.result.structuredContent.cached, true);
  assertIncludes(textOf(second), '缓存命中');
  assert.strictEqual(
    textOf(first).split('———')[0].trim(),
    textOf(second).split('———')[0].trim(),
    '缓存命中的正文必须和首次一致'
  );

  // 换提示词就必须重新调用
  await call(c, 'ocr_image', { image_path: PNG, prompt: '只看左半边' });
  assert.strictEqual(state.reqs.length, 2);
  // 换图片也必须重新调用
  await call(c, 'ocr_image', { image_path: PNG2 });
  assert.strictEqual(state.reqs.length, 3);
  assert.ok(fs.existsSync(cacheDir), '磁盘缓存目录应已创建');
});

// ---------- 多图与 URL ----------

s.test('多图对比：按顺序标注【图1】【图2】', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const res = await call(c, 'compare_images', { image_paths: [PNG, PNG2] });
  assert.strictEqual(res.result.isError, undefined);
  const content = state.reqs[0].body.messages[0].content;
  const texts = content.filter((p) => p.type === 'text').map((p) => p.text);
  assert.ok(texts.some((t) => t.includes('【图1】')));
  assert.ok(texts.some((t) => t.includes('【图2】')));
  assert.strictEqual(content.filter((p) => p.type === 'image_url').length, 2);
  assertIncludes(texts[0], '共 2 张图片');
  assert.strictEqual(res.result.structuredContent.images.length, 2);
});

s.test('image_url 原样透传，不做本地读取', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const res = await call(c, 'analyze_image', { image_url: 'https://example.com/x.png', prompt: '看看' });
  assert.strictEqual(res.result.isError, undefined);
  const img = state.reqs[0].body.messages[0].content.find((p) => p.type === 'image_url');
  assert.strictEqual(img.image_url.url, 'https://example.com/x.png');
});

s.test('未知参数只提示不报错（模型写错参数名也不至于失败）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const res = await call(c, 'ocr_image', { image_path: PNG, langauge: 'zh', detail: 'high' });
  assert.strictEqual(res.result.isError, undefined);
  assertIncludes(textOf(res), 'langauge');
});

s.test('VISION_SHOW_META=false 时输出纯净的识别结果', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok', VISION_SHOW_META: 'false' });
  const res = await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(textOf(res).trim(), '模拟识别结果：左边是红色，右边是蓝色。');
});

s.test('取消不存在的请求不会产生响应包', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'ok' });
  const before = c.unsolicited.length;
  c.notify('notifications/cancelled', { requestId: 12345, reason: 'user aborted' });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepStrictEqual(c.unsolicited.slice(before), []);
  const res = await c.request('ping');
  assert.deepStrictEqual(res.result, {});
});

s.test('客户端超时取消后，上游继续跑完并写入缓存，重试秒回（不回包给已取消的请求）', async () => {
  reset();
  const cacheDir = path.join(TMP, 'cache-cancel');
  const c = await client({ VISION_MODEL: 'slow', VISION_CACHE: 'disk', VISION_CACHE_DIR: cacheDir });

  // 手动发一个 tools/call，然后模拟客户端工具超时把它取消
  const id = 555;
  const before = c.unsolicited.length;
  c.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ocr_image', arguments: { image_path: PNG } } }));
  await new Promise((r) => setTimeout(r, 150));
  c.notify('notifications/cancelled', { requestId: id, reason: 'Tool execution timed out after 30000ms' });

  // 已取消的请求不该再收到响应
  await new Promise((r) => setTimeout(r, 1600));
  const got = c.unsolicited.slice(before).filter((m) => m.id === id);
  assert.deepStrictEqual(got, [], `已取消的请求不应回包，却收到 ${JSON.stringify(got)}`);
  assert.strictEqual(state.counters.slow, 1, '上游应该只调用了一次');

  // 但结果已经落进缓存了：模型原样重试直接命中
  const retry = await call(c, 'ocr_image', { image_path: PNG });
  assert.strictEqual(retry.result.structuredContent.cached, true, '重试应命中缓存');
  assertIncludes(textOf(retry), '慢模型终于返回了');
  assert.strictEqual(state.counters.slow, 1, '重试不该再打一次上游');
});

s.test('并发的相同调用会合并成一次上游请求（省额度也省时间）', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'slow' });
  const [a, b] = await Promise.all([call(c, 'ocr_image', { image_path: PNG }), call(c, 'ocr_image', { image_path: PNG })]);
  assert.strictEqual(state.counters.slow, 1, `两个相同请求应合并为 1 次上游调用，实际 ${state.counters.slow} 次`);
  assertIncludes(textOf(a), '慢模型终于返回了');
  assertIncludes(textOf(b), '慢模型终于返回了');
  // 其中一个会标注自己是合并进来的
  assert.ok([textOf(a), textOf(b)].some((t) => t.includes('合并到进行中的同一请求')));
});

s.test('不同的调用不会被错误合并', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'slow' });
  await Promise.all([call(c, 'ocr_image', { image_path: PNG }), call(c, 'ocr_image', { image_path: PNG2 })]);
  assert.strictEqual(state.counters.slow, 2, '不同图片必须各打一次');
});

s.test('VISION_CANCEL_MODE=abort 时立刻中断上游', async () => {
  reset();
  const c = await client({ VISION_MODEL: 'slow', VISION_CANCEL_MODE: 'abort', VISION_CACHE: 'off' });
  const id = 777;
  c.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ocr_image', arguments: { image_path: PNG } } }));
  await new Promise((r) => setTimeout(r, 150));
  c.notify('notifications/cancelled', { requestId: id, reason: 'user pressed esc' });
  await new Promise((r) => setTimeout(r, 400));
  assertIncludes(c.stderr, '已中止在途的视觉 API 调用');
});

module.exports = s;
if (require.main === module) s.main();

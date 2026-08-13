'use strict';

/**
 * 单元测试：纯函数层。
 * 重点覆盖三类历史 bug：扩展名猜 MIME、按原文件大小卡 10MB、截断不上报。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { suite, assertIncludes, assertThrows, makeTmpDir, cleanupTmp } = require('./harness');
const { makePng } = require('../lib/pngwriter');
const image = require('../lib/image');
const vision = require('../lib/vision');
const { ResultCache } = require('../lib/cache');
const toolsLib = require('../lib/tools');

const s = suite('单元测试 (lib/*)');

function cfg(over) {
  return Object.assign(
    {
      maxImageMB: 5,
      maxImages: 8,
      searchDirs: [],
      pasteDirs: [],
      allowedDirs: [],
      maxTokens: 4096,
      maxTokensField: 'auto',
      temperature: undefined,
    },
    over || {}
  );
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

let TMP;
s.beforeAll(() => {
  TMP = makeTmpDir('vb-unit');
});
s.afterAll(() => cleanupTmp());

// ---------- magic bytes ----------

s.test('sniffMime 认得 PNG / JPEG / GIF / WEBP / BMP', () => {
  assert.strictEqual(image.sniffMime(makePng(4, 4, [1, 2, 3])).mime, 'png');
  assert.strictEqual(image.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).mime, 'jpeg');
  assert.strictEqual(image.sniffMime(Buffer.from('GIF89a....', 'latin1')).mime, 'gif');
  assert.strictEqual(image.sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])).mime, 'webp');
  assert.strictEqual(image.sniffMime(Buffer.from([0x42, 0x4d, 0, 0, 0, 0])).mime, 'bmp');
  for (const m of ['png', 'jpeg', 'gif', 'webp', 'bmp']) assert.ok(image.SUPPORTED.has(m));
});

s.test('sniffMime 识别出不受支持的格式（HEIC / AVIF / TIFF / PDF / SVG）', () => {
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'latin1')]);
  const r = image.sniffMime(heic);
  assert.strictEqual(r.supported, false);
  assertIncludes(r.label, 'HEIC');

  assert.strictEqual(image.sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif', 'latin1')])).supported, false);
  assert.strictEqual(image.sniffMime(Buffer.from([0x49, 0x49, 0x2a, 0x00])).mime, 'tiff');
  assert.strictEqual(image.sniffMime(Buffer.from('%PDF-1.7', 'latin1')).mime, 'pdf');
  assert.strictEqual(image.sniffMime(Buffer.from('<svg xmlns="x">', 'latin1')).mime, 'svg+xml');
});

s.test('sniffMime 对普通文本返回 null（不会被当图片发出去）', () => {
  assert.strictEqual(image.sniffMime(Buffer.from('hello world, not an image')), null);
  assert.strictEqual(image.sniffMime(Buffer.alloc(0)), null);
});

s.test('回归：扩展名是 .png 但内容是 JPEG，按内容判定为 jpeg', () => {
  const f = path.join(TMP, 'liar.png');
  // 真实截图工具改名的典型情形：JPEG 数据存成 .png
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]));
  const img = image.loadLocalImage(f, cfg());
  assert.strictEqual(img.mime, 'image/jpeg', '必须按 magic bytes 判定，不能信扩展名');
  assertIncludes(img.dataUrl.slice(0, 30), 'data:image/jpeg;base64,');
});

s.test('文本文件伪装成图片时报错并提示改用文件读取工具', async () => {
  const f = path.join(TMP, 'fake.png');
  fs.writeFileSync(f, 'SELECT * FROM users; -- 这其实是 SQL');
  const e = await assertThrows(() => image.loadLocalImage(f, cfg()), 'not_an_image');
  assertIncludes(e.hint, '文本文件');
});

// ---------- 体积上限 ----------

s.test('回归：体积上限按 base64 后的字节数判定（原文件不超但编码后超 → 必须拒绝）', async () => {
  const f = path.join(TMP, 'noise.png');
  // 噪声图，避免 deflate 把体积压得太小
  const buf = makePng(48, 48, (x, y) => [(x * 7 + y) % 256, (y * 13 + x * 3) % 256, (x * y * 5) % 256]);
  fs.writeFileSync(f, buf);
  const rawBytes = buf.length;
  const b64Bytes = buf.toString('base64').length;
  assert.ok(b64Bytes > rawBytes, 'base64 必然比原文件大');

  // 阈值卡在两者之间：旧实现（按原文件大小）会放行，新实现必须拦住
  const midMB = (rawBytes + (b64Bytes - rawBytes) / 2) / (1024 * 1024);
  const e = await assertThrows(() => image.loadLocalImage(f, cfg({ maxImageMB: midMB })), 'image_too_large');
  assertIncludes(e.message, '1.33');
  assertIncludes(e.hint, 'VISION_MAX_IMAGE_MB');

  // 阈值给足就能通过，且 payloadBytes 是 base64 长度
  const okImg = image.loadLocalImage(f, cfg({ maxImageMB: (b64Bytes + 64) / (1024 * 1024) }));
  assert.strictEqual(okImg.payloadBytes, b64Bytes);
  assert.strictEqual(okImg.bytes, rawBytes);
});

s.test('空文件单独报错', async () => {
  const f = path.join(TMP, 'empty.png');
  fs.writeFileSync(f, Buffer.alloc(0));
  await assertThrows(() => image.loadLocalImage(f, cfg()), 'empty_file');
});

// ---------- 路径归一化 ----------

s.test('expandRaw 去掉引号/反引号/尖括号', () => {
  const want = process.platform === 'win32' ? 'C:/tmp/a.png' : '/tmp/a.png';
  for (const wrapped of [`"${want}"`, `'${want}'`, '`' + want + '`', `<${want}>`, `  ${want}  `]) {
    assert.strictEqual(image.expandRaw(wrapped), want, `处理 ${wrapped} 失败`);
  }
});

s.test('expandRaw 展开 ~ 与环境变量，解析 file:// URL', () => {
  assert.strictEqual(image.expandRaw('~'), os.homedir());
  assert.ok(image.expandRaw('~/a.png').startsWith(os.homedir()));
  process.env.VB_TEST_DIR = 'ZZZ';
  assertIncludes(image.expandRaw('%VB_TEST_DIR%/a.png'), 'ZZZ');
  assertIncludes(image.expandRaw('${VB_TEST_DIR}/a.png'), 'ZZZ');
  delete process.env.VB_TEST_DIR;

  const f = path.join(TMP, 'url test.png');
  const url = process.platform === 'win32' ? 'file:///' + f.replace(/\\/g, '/').replace(/ /g, '%20') : 'file://' + f.replace(/ /g, '%20');
  assert.strictEqual(path.resolve(image.expandRaw(url)), path.resolve(f));
});

s.test('expandRaw 还原 /c/Users 与 /mnt/c/Users 风格盘符（Windows）', () => {
  if (process.platform !== 'win32') return 'skip';
  assert.strictEqual(image.expandRaw('/c/Users/foo/a.png'), 'c:/Users/foo/a.png');
  assert.strictEqual(image.expandRaw('/mnt/d/pics/a.png'), 'd:/pics/a.png');
});

s.test('相对路径会在 searchDirs 里逐个尝试（MCP 进程的 cwd 通常不是项目目录）', () => {
  const sub = path.join(TMP, 'proj', 'shots');
  fs.mkdirSync(sub, { recursive: true });
  const f = path.join(sub, 'rel.png');
  fs.writeFileSync(f, makePng(4, 4, [9, 9, 9]));
  const img = image.loadLocalImage('shots/rel.png', cfg({ searchDirs: [path.join(TMP, 'proj')] }));
  assert.strictEqual(path.resolve(img.file), path.resolve(f));
  assert.strictEqual(img.via, 'search-dir');
});

s.test('找不到文件时，报错里列出试过的位置并教模型怎么改', async () => {
  const e = await assertThrows(() => image.loadLocalImage('no-such-file.png', cfg({ searchDirs: [TMP] })), 'file_not_found');
  assertIncludes(e.hint, TMP);
  assertIncludes(e.hint, 'latest');
  assert.ok(Array.isArray(e.details.tried) && e.details.tried.length > 0);
});

s.test('传目录进来会明确说“这是目录”', async () => {
  await assertThrows(() => image.loadLocalImage(TMP, cfg()), 'is_directory');
});

s.test('image_path="latest" 取粘贴目录里最新的图片', () => {
  const pasteDir = path.join(TMP, 'image-cache', 'sess_abc');
  fs.mkdirSync(pasteDir, { recursive: true });
  const older = path.join(pasteDir, 'image-old.png');
  const newer = path.join(pasteDir, 'image-new.png');
  fs.writeFileSync(older, makePng(4, 4, [1, 1, 1]));
  fs.writeFileSync(newer, makePng(4, 4, [2, 2, 2]));
  const t = Date.now() / 1000;
  fs.utimesSync(older, t - 600, t - 600);
  fs.utimesSync(newer, t - 5, t - 5);

  const c = cfg({ pasteDirs: [path.join(TMP, 'image-cache')] });
  for (const word of ['latest', 'LATEST', '最新', '剪贴板']) {
    const img = image.loadLocalImage(word, c);
    assert.strictEqual(path.basename(img.file), 'image-new.png', `关键字 ${word} 应命中最新的图`);
    assert.strictEqual(img.via, 'latest');
  }
});

s.test('粘贴目录为空时，latest 给出可执行的提示', async () => {
  const empty = path.join(TMP, 'nothing-here');
  fs.mkdirSync(empty, { recursive: true });
  const e = await assertThrows(() => image.loadLocalImage('latest', cfg({ pasteDirs: [empty] })), 'no_latest_image');
  assertIncludes(e.hint, '绝对路径');
});

s.test('VISION_ALLOWED_DIRS 白名单：目录外的文件读不到', async () => {
  const insideDir = path.join(TMP, 'allowed');
  fs.mkdirSync(insideDir, { recursive: true });
  const inside = path.join(insideDir, 'in.png');
  const outside = path.join(TMP, 'out.png');
  fs.writeFileSync(inside, makePng(4, 4, [3, 3, 3]));
  fs.writeFileSync(outside, makePng(4, 4, [4, 4, 4]));

  const c = cfg({ allowedDirs: [insideDir] });
  assert.ok(image.loadLocalImage(inside, c).file);
  const e = await assertThrows(() => image.loadLocalImage(outside, c), 'path_not_allowed');
  assertIncludes(e.hint, insideDir);
});

// ---------- 参数收敛 ----------

s.test('collectImages：没给图片时报错并说清参数名', async () => {
  const e = await assertThrows(() => image.collectImages({}, cfg()), 'no_image');
  assertIncludes(e.hint, 'image_path');
  assertIncludes(e.hint, 'latest');
});

s.test('collectImages：认得模型自己发明的别名（path / file / images）', () => {
  const f = path.join(TMP, 'alias.png');
  fs.writeFileSync(f, makePng(4, 4, [5, 5, 5]));
  for (const key of ['path', 'file', 'image', 'imagePath']) {
    const imgs = image.collectImages({ [key]: f }, cfg());
    assert.strictEqual(imgs.length, 1, `别名 ${key} 应该被认出来`);
  }
  assert.strictEqual(image.collectImages({ images: [f, f] }, cfg()).length, 2);
});

s.test('collectImages：URL 塞进 image_path 也能自动纠正', () => {
  const imgs = image.collectImages({ image_path: 'https://example.com/a.png' }, cfg());
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0].kind, 'url');
  assert.strictEqual(imgs[0].url, 'https://example.com/a.png');
});

s.test('collectImages：超过 maxImages 时报错', async () => {
  const f = path.join(TMP, 'many.png');
  fs.writeFileSync(f, makePng(4, 4, [6, 6, 6]));
  await assertThrows(() => image.collectImages({ image_paths: [f, f, f] }, cfg({ maxImages: 2 })), 'too_many_images');
});

s.test('loadRemoteImage 拒绝非 http(s) 协议并指路 image_path', async () => {
  await assertThrows(() => image.loadRemoteImage('ftp://x/a.png'), 'bad_url');
  const e = await assertThrows(() => image.loadRemoteImage('file:///tmp/a.png'), 'bad_url');
  assertIncludes(e.hint, 'image_path');
});

// ---------- 响应解析 ----------

s.test('回归：finish_reason=length 必须被识别为“输出被截断”', () => {
  const r = vision.parseOpenAIResponse(JSON.stringify({ choices: [{ message: { content: '半截内容' }, finish_reason: 'length' }] }));
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.text, '半截内容');

  const ok = vision.parseOpenAIResponse(JSON.stringify({ choices: [{ message: { content: '完整' }, finish_reason: 'stop' }] }));
  assert.strictEqual(ok.truncated, false);
});

s.test('parseOpenAIResponse 兼容 content 数组与 reasoning_content 兜底', () => {
  const arr = vision.parseOpenAIResponse(JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }));
  assert.strictEqual(arr.text, 'ab');
  const reason = vision.parseOpenAIResponse(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '思考里的内容' } }] }));
  assert.strictEqual(reason.text, '思考里的内容');
});

s.test('parseGeminiResponse：MAX_TOKENS 判截断、过滤 thought、安全拦截报错', async () => {
  const r = vision.parseGeminiResponse(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '想法', thought: true }, { text: '正文' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 },
    })
  );
  assert.strictEqual(r.text, '正文');
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.usage.in, 10);
  assert.strictEqual(r.usage.out, 25);

  await assertThrows(() => vision.parseGeminiResponse(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })), 'blocked');
});

s.test('normalizeUsage 兼容多种字段命名', () => {
  assert.deepStrictEqual(vision.normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }), { in: 1, out: 2, total: 3 });
  assert.deepStrictEqual(vision.normalizeUsage({ input_tokens: 4, output_tokens: 5 }), { in: 4, out: 5, total: 9 });
  assert.strictEqual(vision.normalizeUsage(undefined), null);
  assert.strictEqual(vision.normalizeUsage({}), null);
});

s.test('parseRetryAfter 支持秒数与 HTTP 日期', () => {
  assert.strictEqual(vision.parseRetryAfter({ 'retry-after': '3' }), 3000);
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = vision.parseRetryAfter({ 'retry-after': future });
  assert.ok(ms > 1000 && ms <= 6000, `期望约 5s，实际 ${ms}`);
  assert.strictEqual(vision.parseRetryAfter({}), null);
});

s.test('extractApiMessage 能从各种错误体里挖出人话', () => {
  assert.strictEqual(vision.extractApiMessage(JSON.stringify({ error: { message: '额度不足' } })), '额度不足');
  assert.strictEqual(vision.extractApiMessage(JSON.stringify({ error: '限流' })), '限流');
  assert.strictEqual(vision.extractApiMessage(JSON.stringify({ msg: '签名错误' })), '签名错误');
  assertIncludes(vision.extractApiMessage('<html>502 Bad Gateway</html>'), '502');
});

// ---------- 请求构造 ----------

s.test('buildOpenAIRequest：字段名可切换、无 key 不发 Authorization、多图带图号', () => {
  const candidate = { model: 'm1', apiBase: 'https://api.test/v1', apiKey: '', apiStyle: 'openai' };
  const imgs = [
    { kind: 'path', dataUrl: 'data:image/png;base64,AAA' },
    { kind: 'path', dataUrl: 'data:image/png;base64,BBB' },
  ];
  const q = { maxTokensField: 'max_tokens', noTemperature: false };
  const r1 = vision.buildOpenAIRequest(candidate, imgs, 'p', 2048, 0.01, q);
  const b1 = JSON.parse(r1.body);
  assert.strictEqual(r1.url, 'https://api.test/v1/chat/completions');
  assert.strictEqual(b1.max_tokens, 2048);
  assert.strictEqual(b1.temperature, 0.01);
  assert.ok(!('Authorization' in r1.headers), '没有 key 时不应带 Authorization（本地 Ollama）');
  const texts = b1.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(texts.includes('【图1】') && texts.includes('【图2】'), '多图必须标注图号');

  const b2 = JSON.parse(vision.buildOpenAIRequest({ ...candidate, apiKey: 'k' }, imgs, 'p', 999, 0.5, { maxTokensField: 'max_completion_tokens', noTemperature: true }).body);
  assert.strictEqual(b2.max_completion_tokens, 999);
  assert.strictEqual(b2.max_tokens, undefined);
  assert.strictEqual(b2.temperature, undefined, 'noTemperature 时不应发 temperature');
});

s.test('buildGeminiRequest：关掉 thinking、去掉 /openai 后缀、拒绝远程 URL', async () => {
  const candidate = { model: 'gemini-3.5-flash', apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', apiStyle: 'gemini-native' };
  const r = vision.buildGeminiRequest(candidate, [{ kind: 'path', mime: 'image/png', base64: 'AAA' }], 'p', 4096, undefined);
  assert.strictEqual(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  assert.strictEqual(r.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.generationConfig.thinkingConfig.includeThoughts, false);
  assert.strictEqual(body.generationConfig.maxOutputTokens, 4096);
  await assertThrows(() => vision.buildGeminiRequest(candidate, [{ kind: 'url', url: 'https://x/a.png' }], 'p', 100), 'style_unsupported');
});

s.test('reasoning_effort 与 extraBody 能注入请求体（经中转站关 Gemini 思考模式）', () => {
  const candidate = { model: 'gemini-3.6-flash', apiBase: 'https://relay.test/v1', apiKey: 'k', apiStyle: 'openai' };
  const imgs = [{ kind: 'path', dataUrl: 'data:image/png;base64,AAA' }];
  const q = { maxTokensField: 'max_tokens', noTemperature: false, noReasoningEffort: false };

  const b1 = JSON.parse(vision.buildOpenAIRequest(candidate, imgs, 'p', 4096, 0.01, q, { reasoningEffort: 'none' }).body);
  assert.strictEqual(b1.reasoning_effort, 'none');

  // 服务商不认时的兜底：quirks 标记后就不再发
  const b2 = JSON.parse(vision.buildOpenAIRequest(candidate, imgs, 'p', 4096, 0.01, { ...q, noReasoningEffort: true }, { reasoningEffort: 'none' }).body);
  assert.strictEqual(b2.reasoning_effort, undefined);

  // extraBody 深合并，且优先级最高
  const b3 = JSON.parse(
    vision.buildOpenAIRequest(candidate, imgs, 'p', 4096, 0.01, q, {
      reasoningEffort: 'low',
      extraBody: { extra_body: { google: { thinking_config: { thinking_budget: 0 } } }, temperature: 0.9 },
    }).body
  );
  assert.strictEqual(b3.extra_body.google.thinking_config.thinking_budget, 0);
  assert.strictEqual(b3.temperature, 0.9, 'extraBody 应能覆盖同名字段');
  assert.strictEqual(b3.max_tokens, 4096, '不该被 extraBody 抹掉');
});

s.test('gemini-native 风格下 extraBody 深合并进 generationConfig（不整块替换）', () => {
  const candidate = { model: 'gemini-3.6-flash', apiBase: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', apiStyle: 'gemini-native' };
  const body = JSON.parse(
    vision.buildGeminiRequest(candidate, [{ kind: 'path', mime: 'image/png', base64: 'A' }], 'p', 4096, undefined, {
      extraBody: { generationConfig: { topK: 40 } },
    }).body
  );
  assert.strictEqual(body.generationConfig.topK, 40);
  assert.strictEqual(body.generationConfig.maxOutputTokens, 4096, 'generationConfig 里原有的字段必须保留');
  assert.strictEqual(body.generationConfig.thinkingConfig.includeThoughts, false);
});

s.test('deepMerge 只递归纯对象，数组整体替换', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2] };
  vision.deepMerge(base, { a: { c: 3, d: 4 }, list: [9] });
  assert.deepStrictEqual(base, { a: { b: 1, c: 3, d: 4 }, list: [9] });
  assert.deepStrictEqual(vision.deepMerge({ x: 1 }, undefined), { x: 1 });
});

s.test('VISION_EXTRA_BODY 解析：合法 JSON 生效，坏 JSON 只告警', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_EXTRA_BODY: '{"reasoning_effort":"none"}', VISION_REASONING_EFFORT: 'low' }, ({ config }) => {
    assert.deepStrictEqual(config.extraBody, { reasoning_effort: 'none' });
    assert.strictEqual(config.reasoningEffort, 'low');
  });
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_EXTRA_BODY: '不是JSON' }, ({ config }) => {
    assert.deepStrictEqual(config.extraBody, {});
    assert.ok(config.warnings.some((w) => w.includes('VISION_EXTRA_BODY')));
  });
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_EXTRA_BODY: '[1,2]' }, ({ config }) => {
    assert.deepStrictEqual(config.extraBody, {});
    assert.ok(config.warnings.some((w) => w.includes('JSON 对象')));
  });
});

s.test('isLocalBase 认得本地推理服务', () => {
  assert.ok(vision.isLocalBase('http://localhost:11434/v1'));
  assert.ok(vision.isLocalBase('http://127.0.0.1:8000/v1'));
  assert.ok(!vision.isLocalBase('https://open.bigmodel.cn/api/paas/v4'));
});

// ---------- 提示词 ----------

s.test('buildPrompt：专用工具内置指令 + 额外要求 + 多图说明', () => {
  const ocr = toolsLib.TOOL_MAP.get('ocr_image');
  const p1 = toolsLib.buildPrompt(ocr, '', 1);
  assertIncludes(p1, '逐字转录');
  const p2 = toolsLib.buildPrompt(ocr, '只转录左半边', 1);
  assertIncludes(p2, '只转录左半边');
  assertIncludes(p2, '逐字转录', '额外要求不应覆盖内置指令');
  assertIncludes(toolsLib.buildPrompt(ocr, '', 3), '【图3】');

  const generic = toolsLib.TOOL_MAP.get('analyze_image');
  assertIncludes(toolsLib.buildPrompt(generic, '', 1), generic.defaultAsk);
  assertIncludes(toolsLib.buildPrompt(generic, '这是什么报错', 1), '这是什么报错');
});

s.test('工具 schema：二选一约束 + 禁止多余参数 + 只读注解', () => {
  const list = toolsLib.listTools();
  assert.strictEqual(list.length, 5);
  for (const t of list) {
    assert.ok(Array.isArray(t.inputSchema.anyOf) && t.inputSchema.anyOf.length >= 2, `${t.name} 缺少 anyOf 约束`);
    assert.strictEqual(t.inputSchema.additionalProperties, false, `${t.name} 应禁止多余参数`);
    assert.strictEqual(t.annotations.readOnlyHint, true, `${t.name} 缺少 readOnlyHint`);
    assert.strictEqual(t.annotations.openWorldHint, true, `${t.name} 缺少 openWorldHint`);
    assert.ok(t.description.length > 60, `${t.name} 的 description 太短，纯文本模型选不准工具`);
  }
  const cmp = list.find((t) => t.name === 'compare_images');
  assert.deepStrictEqual(cmp.inputSchema.anyOf, [{ required: ['image_paths'] }, { required: ['image_urls'] }]);
});

// ---------- 缓存 ----------

s.test('缓存 key：同输入同 key，换图/换提示词/换模型都换 key', () => {
  const c = new ResultCache({ cacheMode: 'off', cacheDir: TMP, cacheTtlMs: 1000, cacheMaxEntries: 10 }, noopLog);
  const base = { imageIds: ['sha256:a'], prompt: 'p', model: 'm', apiStyle: 'openai', apiBase: 'b', maxTokens: 100, temperature: 0 };
  const k = c.key(base);
  assert.strictEqual(k, c.key({ ...base }));
  assert.notStrictEqual(k, c.key({ ...base, imageIds: ['sha256:b'] }));
  assert.notStrictEqual(k, c.key({ ...base, prompt: 'p2' }));
  assert.notStrictEqual(k, c.key({ ...base, model: 'm2' }));
  assert.notStrictEqual(k, c.key({ ...base, maxTokens: 200 }));
  // 多图顺序不影响命中
  assert.strictEqual(c.key({ ...base, imageIds: ['a', 'b'] }), c.key({ ...base, imageIds: ['b', 'a'] }));
});

s.test('磁盘缓存可跨进程复用，过期即失效，clear 能清干净', () => {
  const dir = path.join(TMP, 'cache-test');
  const mk = (ttl) => new ResultCache({ cacheMode: 'disk', cacheDir: dir, cacheTtlMs: ttl, cacheMaxEntries: 10 }, noopLog);
  const c1 = mk(60000);
  const key = c1.key({ imageIds: ['x'], prompt: 'p', model: 'm' });
  c1.set(key, { text: '识别结果', model: 'm', usage: { in: 1, out: 2 } });

  // 新实例（模拟下一个会话）应能从磁盘读到
  const c2 = mk(60000);
  const hit = c2.get(key);
  assert.ok(hit, '磁盘缓存应命中');
  assert.strictEqual(hit.text, '识别结果');
  assert.strictEqual(hit.from, 'disk');

  // TTL=0 视为立刻过期
  assert.strictEqual(mk(0).get(key), null);

  const c3 = mk(60000);
  c3.set(c3.key({ imageIds: ['y'], prompt: 'p', model: 'm' }), { text: 'b' });
  assert.ok(c3.clear() >= 1);
  assert.strictEqual(mk(60000).get(key), null);
});

s.test('cacheMode=off 时不读不写', () => {
  const c = new ResultCache({ cacheMode: 'off', cacheDir: path.join(TMP, 'nope'), cacheTtlMs: 1000, cacheMaxEntries: 10 }, noopLog);
  const k = c.key({ imageIds: ['z'] });
  c.set(k, { text: 'x' });
  assert.strictEqual(c.get(k), null);
  assert.strictEqual(fs.existsSync(path.join(TMP, 'nope')), false);
});

s.test('内存缓存按 LRU 淘汰，不会无限膨胀', () => {
  const c = new ResultCache({ cacheMode: 'memory', cacheDir: TMP, cacheTtlMs: 60000, cacheMaxEntries: 3 }, noopLog);
  for (let i = 0; i < 10; i++) c.set(`k${i}`, { text: `t${i}` });
  assert.ok(c.mem.size <= 3, `内存条目应 ≤3，实际 ${c.mem.size}`);
  assert.ok(c.get('k9'));
  assert.strictEqual(c.get('k0'), null);
});

// ---------- 配置 ----------

function withEnv(vars, fn) {
  const saved = {};
  const keys = Object.keys(vars);
  for (const k of keys) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  // config.js 在 require 时求值，需要清缓存重载
  delete require.cache[require.resolve('../lib/config')];
  try {
    return fn(require('../lib/config'));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../lib/config')];
  }
}

const CLEAN_ENV = {
  VISION_API_KEY: undefined,
  VISION_API_BASE: undefined,
  VISION_MODEL: undefined,
  VISION_API_STYLE: undefined,
  VISION_FALLBACKS: undefined,
  VISION_MAX_TOKENS: undefined,
  VISION_CACHE: undefined,
  VISION_MAX_IMAGE_MB: undefined,
  VISION_EXTRA_BODY: undefined,
  VISION_REASONING_EFFORT: undefined,
};

s.test('VISION_MODEL 逗号分隔 → 降级候选链', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_MODEL: 'glm-4v-flash, glm-4v-plus ,glm-4v' }, ({ config }) => {
    assert.strictEqual(config.candidates.length, 3);
    assert.deepStrictEqual(config.candidates.map((c) => c.model), ['glm-4v-flash', 'glm-4v-plus', 'glm-4v']);
    for (const c of config.candidates) assert.strictEqual(c.apiKey, 'k');
  });
});

s.test('候选可用 | 覆盖 base/key（跨服务商降级）', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k1', VISION_MODEL: 'a,b|https://other.test/v1|k2' }, ({ config }) => {
    assert.strictEqual(config.candidates[1].apiBase, 'https://other.test/v1');
    assert.strictEqual(config.candidates[1].apiKey, 'k2');
    assert.strictEqual(config.candidates[0].apiKey, 'k1', '没写第三段应继承全局 Key');
  });
  // 尾部空的第三段 = 显式不带 Key（本地模型兜底），不能把云端 Key 发到 localhost
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'cloud-key', VISION_MODEL: 'glm-4v-flash,qwen2.5-vl|http://localhost:11434/v1|' }, ({ config }) => {
    assert.strictEqual(config.candidates[1].apiKey, '');
    assert.strictEqual(config.candidates[1].apiBase, 'http://localhost:11434/v1');
  });
});

s.test('VISION_FALLBACKS 支持 JSON 数组，非法 JSON 只告警不崩', () => {
  withEnv(
    { ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_MODEL: 'main', VISION_FALLBACKS: '[{"model":"backup","api_base":"http://localhost:11434/v1"}]' },
    ({ config }) => {
      assert.strictEqual(config.candidates.length, 2);
      assert.strictEqual(config.candidates[1].model, 'backup');
      assert.strictEqual(config.candidates[1].apiBase, 'http://localhost:11434/v1');
    }
  );
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_FALLBACKS: '{坏 JSON' }, ({ config }) => {
    assert.strictEqual(config.candidates.length, 1);
    assert.ok(config.warnings.some((w) => w.includes('VISION_FALLBACKS')));
  });
});

s.test('Gemini 域名自动切到原生端点（避免思考模式截断），显式指定时不覆盖', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_API_BASE: 'https://generativelanguage.googleapis.com/v1beta/openai' }, ({ config }) => {
    assert.strictEqual(config.candidates[0].apiStyle, 'gemini-native');
  });
  withEnv(
    { ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_API_BASE: 'https://generativelanguage.googleapis.com/v1beta/openai', VISION_API_STYLE: 'openai' },
    ({ config }) => assert.strictEqual(config.candidates[0].apiStyle, 'openai')
  );
});

s.test('默认 max_tokens 是 4096（不再是会截断 OCR 的 1024），非法值回退并告警', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k' }, ({ config }) => assert.strictEqual(config.maxTokens, 4096));
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_MAX_TOKENS: '8000' }, ({ config }) => assert.strictEqual(config.maxTokens, 8000));
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'k', VISION_MAX_TOKENS: 'abc' }, ({ config }) => {
    assert.strictEqual(config.maxTokens, 4096);
    assert.ok(config.warnings.some((w) => w.includes('VISION_MAX_TOKENS')));
  });
});

s.test('snapshot 永远不泄露完整 API Key', () => {
  withEnv({ ...CLEAN_ENV, VISION_API_KEY: 'super-secret-key-1234567890' }, ({ snapshot }) => {
    const dump = JSON.stringify(snapshot());
    assert.ok(!dump.includes('super-secret-key-1234567890'), 'snapshot 里不能出现完整 Key');
    assertIncludes(dump, 'supe');
  });
});

// ---------- PNG 生成器（测试自身的地基） ----------

s.test('makePng 产出的是合法 PNG', () => {
  const buf = makePng(8, 8, [10, 20, 30]);
  assert.strictEqual(image.sniffMime(buf).mime, 'png');
  assertIncludes(buf.toString('latin1'), 'IHDR');
  assertIncludes(buf.toString('latin1'), 'IEND');
});

module.exports = s;
if (require.main === module) s.main();

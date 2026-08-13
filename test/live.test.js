'use strict';

/**
 * 真实 API 测试：会消耗额度，所以默认跳过。
 *   node test/run-tests.js --live      （从 ~/.zcode/cli/config.json 或环境变量取 Key）
 * 断言只做“链路是否通、字段是否齐”，不对模型措辞做脆弱的字符串匹配。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { suite, assertIncludes, makeTmpDir, cleanupTmp, MCPClient, loadLiveEnv } = require('./harness');
const { makeTwoTonePng } = require('../lib/pngwriter');

const s = suite('真实 API 测试 (--live)');

const LIVE = process.argv.includes('--live') || process.env.VISION_TEST_LIVE === '1';
let env = null;
let TMP;
let PNG;
let cli;

s.beforeAll(async () => {
  if (!LIVE) return;
  env = loadLiveEnv();
  if (!env) return;
  TMP = makeTmpDir('vb-live');
  PNG = path.join(TMP, 'two-tone.png');
  fs.writeFileSync(PNG, makeTwoTonePng(128));
  cli = new MCPClient({
    args: ['--use-env-proxy'],
    env: { ...env, VISION_CACHE: 'disk', VISION_CACHE_DIR: path.join(TMP, 'cache'), VISION_LOG: 'off' },
  }).start();
  await cli.handshake();
});

s.afterAll(() => {
  if (cli) cli.stop();
  cleanupTmp();
});

function guard() {
  if (!LIVE) return 'skip';
  if (!env) {
    process.stdout.write('      （没找到可用的 VISION_API_KEY，跳过）\n');
    return 'skip';
  }
  return null;
}

let firstText = '';

s.test('真实调用视觉 API：能认出左红右蓝', async () => {
  const g = guard();
  if (g) return g;
  const res = await cli.request(
    'tools/call',
    { name: 'analyze_image', arguments: { image_path: PNG, prompt: '这张图左右两半各是什么颜色？只用一句话回答。' } },
    120000
  );
  assert.ok(res.result, `期望 result，实际 ${JSON.stringify(res).slice(0, 400)}`);
  assert.notStrictEqual(res.result.isError, true, `调用失败：${res.result.content && res.result.content[0].text}`);
  const text = res.result.content[0].text;
  firstText = text;
  process.stdout.write(`      模型(${res.result.structuredContent.model}) 回答: ${text.split('\n')[0].slice(0, 120)}\n`);
  assert.ok(/红|red/i.test(text), '应认出红色');
  assert.ok(/蓝|blue/i.test(text), '应认出蓝色');
});

s.test('返回里带上 usage / 耗时 / 模型信息', async () => {
  const g = guard();
  if (g) return g;
  const res = await cli.request('tools/call', { name: 'analyze_image', arguments: { image_path: PNG, prompt: '这张图左右两半各是什么颜色？只用一句话回答。' } }, 120000);
  const sc = res.result.structuredContent;
  assert.ok(sc.model, '缺少 model');
  assert.ok(sc.host, '缺少 host');
  if (sc.usage) {
    assert.ok(sc.usage.in > 0, `input tokens 应大于 0，实际 ${JSON.stringify(sc.usage)}`);
    process.stdout.write(`      用量: in=${sc.usage.in} out=${sc.usage.out}\n`);
  } else {
    process.stdout.write('      （该服务商没返回 usage 字段）\n');
  }
});

s.test('第二次相同请求命中缓存（省额度）', async () => {
  const g = guard();
  if (g) return g;
  const res = await cli.request('tools/call', { name: 'analyze_image', arguments: { image_path: PNG, prompt: '这张图左右两半各是什么颜色？只用一句话回答。' } }, 120000);
  assert.strictEqual(res.result.structuredContent.cached, true, '相同请求应命中缓存');
  assertIncludes(res.result.content[0].text, '缓存命中');
});

s.test('OCR 工具对无文字图片也能正常返回（不报错）', async () => {
  const g = guard();
  if (g) return g;
  const res = await cli.request('tools/call', { name: 'ocr_image', arguments: { image_path: PNG } }, 120000);
  assert.ok(res.result);
  assert.notStrictEqual(res.result.isError, true, `OCR 失败：${res.result.content && res.result.content[0].text}`);
  process.stdout.write(`      OCR 输出首行: ${res.result.content[0].text.split('\n')[0].slice(0, 100)}\n`);
});

module.exports = s;
if (require.main === module) s.main();

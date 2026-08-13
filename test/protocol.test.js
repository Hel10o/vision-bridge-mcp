'use strict';

/**
 * 协议测试：spawn 真实的 server.js，用模拟客户端跑完整 JSON-RPC 流程。
 * 不需要 API Key，全部离线可跑。
 * 重点覆盖：业务失败必须是 isError result、通知不能有响应、进程不能被弄死。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { suite, assertIncludes, makeTmpDir, cleanupTmp, MCPClient } = require('./harness');
const { makePng } = require('../lib/pngwriter');
const PKG = require('../package.json');

const s = suite('协议测试 (server.js, 离线)');

let TMP;
let cli;
let PNG;

s.beforeAll(async () => {
  TMP = makeTmpDir('vb-proto');
  PNG = path.join(TMP, 'real.png');
  fs.writeFileSync(PNG, makePng(16, 16, [200, 30, 30]));
  cli = new MCPClient().start();
  await cli.handshake();
});

s.afterAll(() => {
  if (cli) cli.stop();
  cleanupTmp();
});

const callTool = (name, args, timeout) => cli.request('tools/call', { name, arguments: args }, timeout || 20000);

// ---------- 握手 ----------

s.test('initialize 握手成功，版本号来自 package.json（不再硬编码）', async () => {
  const c = new MCPClient().start();
  try {
    const res = await c.handshake('2024-11-05');
    assert.ok(res.result, `期望 result，实际 ${JSON.stringify(res)}`);
    assert.strictEqual(res.result.serverInfo.name, 'vision-bridge');
    assert.strictEqual(res.result.serverInfo.version, PKG.version);
    assert.notStrictEqual(res.result.serverInfo.version, '1.0.0');
    assert.strictEqual(res.result.protocolVersion, '2024-11-05', '应沿用客户端请求的协议版本');
    assert.ok(res.result.capabilities.tools, '必须声明 tools 能力');
    assertIncludes(res.result.instructions, 'ocr_image');
  } finally {
    c.stop();
  }
});

s.test('客户端请求未知协议版本时，返回服务器支持的版本', async () => {
  const c = new MCPClient().start();
  try {
    const res = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(res.result.protocolVersion, '2025-06-18');
  } finally {
    c.stop();
  }
});

s.test('ping 返回空结果', async () => {
  const res = await cli.request('ping');
  assert.deepStrictEqual(res.result, {});
});

// ---------- 工具清单 ----------

s.test('tools/list 返回 5 个工具，都带 anyOf 约束与只读注解', async () => {
  const res = await cli.request('tools/list');
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['analyze_image', 'compare_images', 'describe_ui', 'ocr_image', 'read_error_screenshot']);
  for (const t of res.result.tools) {
    assert.ok(t.inputSchema.anyOf, `${t.name} 应有 anyOf（图片参数二选一）`);
    assert.strictEqual(t.inputSchema.additionalProperties, false);
    assert.strictEqual(t.annotations.readOnlyHint, true);
  }
});

// ---------- 通知类消息绝不回包 ----------

s.test('回归：notifications/initialized 不产生任何响应', async () => {
  cli.notify('notifications/initialized');
  const got = await cli.collectUnsolicited(300);
  assert.deepStrictEqual(got, [], `通知不该有响应，却收到 ${JSON.stringify(got)}`);
});

s.test('回归：未白名单的通知（notifications/roots/list_changed）也不产生带空 id 的非法响应', async () => {
  cli.notify('notifications/roots/list_changed');
  cli.notify('notifications/progress', { progressToken: 1, progress: 50 });
  cli.notify('notifications/cancelled', { requestId: 99999, reason: 'user' });
  const got = await cli.collectUnsolicited(400);
  assert.deepStrictEqual(got, [], `收到了不该有的报文：${JSON.stringify(got)}`);
});

s.test('无 id 的请求（视为通知）不产生响应', async () => {
  cli.writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }));
  cli.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/list' }));
  const got = await cli.collectUnsolicited(400);
  assert.deepStrictEqual(got, []);
});

// ---------- 协议级错误仍然用 JSON-RPC error ----------

s.test('未知方法 → JSON-RPC error -32601', async () => {
  const res = await cli.request('foo/bar');
  assert.ok(res.error, '未知方法应返回 error');
  assert.strictEqual(res.error.code, -32601);
  assert.strictEqual(res.result, undefined);
});

s.test('tools/call 缺 name → JSON-RPC error -32602', async () => {
  const res = await cli.request('tools/call', { arguments: {} });
  assert.ok(res.error);
  assert.strictEqual(res.error.code, -32602);
});

// ---------- 业务失败 → isError result ----------

s.test('回归：图片不存在 → isError result（不是 JSON-RPC error），且给出可执行提示', async () => {
  const res = await callTool('ocr_image', { image_path: 'C:/definitely/not/here.png' });
  assert.strictEqual(res.error, undefined, '业务失败不能用 JSON-RPC error，否则客户端会当成服务器故障');
  assert.ok(res.result, '应返回 result');
  assert.strictEqual(res.result.isError, true, 'result.isError 必须为 true');
  const text = res.result.content[0].text;
  assertIncludes(text, '图片文件不存在');
  assertIncludes(text, '下一步', '必须告诉模型下一步怎么办');
  assertIncludes(text, 'latest');
  assert.strictEqual(res.result.structuredContent.error.code, 'file_not_found');
});

s.test('未知工具名 → isError 并列出可用工具', async () => {
  const res = await callTool('do_magic', { image_path: PNG });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, 'ocr_image');
});

s.test('一个图片参数都不传 → isError 并说明参数名', async () => {
  const res = await callTool('ocr_image', {});
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, 'image_path');
});

s.test('文本文件伪装成 .png → isError 说清不是图片（magic bytes 生效）', async () => {
  const fake = path.join(TMP, 'notes.png');
  fs.writeFileSync(fake, '这是一份笔记，不是图片\nline2');
  const res = await callTool('ocr_image', { image_path: fake });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, '不是可识别的图片');
});

s.test('compare_images 只给一张图 → isError 提示用数组传多张', async () => {
  const res = await callTool('compare_images', { image_paths: [PNG] });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, 'image_paths');
});

s.test('没有 API Key 时 → isError 指路 VISION_API_KEY（而不是崩掉）', async () => {
  const res = await callTool('analyze_image', { image_path: PNG, prompt: '这是什么' });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, 'VISION_API_KEY');
});

s.test('传目录进来 → isError 说明是目录', async () => {
  const res = await callTool('ocr_image', { image_path: TMP });
  assert.strictEqual(res.result.isError, true);
  assertIncludes(res.result.content[0].text, '目录');
});

// ---------- 健壮性 ----------

s.test('畸形 JSON → 回 parse error 且服务器继续存活', async () => {
  cli.writeRaw('{ 这不是 JSON');
  await new Promise((r) => setTimeout(r, 200));
  const parseErr = cli.unsolicited.find((m) => m.error && m.error.code === -32700);
  assert.ok(parseErr, '应回一条 -32700 Parse error');
  assert.strictEqual(parseErr.id, null, 'parse error 的 id 应为 null');
  // 进程还活着
  const res = await cli.request('ping');
  assert.deepStrictEqual(res.result, {});
});

s.test('空行与非对象报文不会打断服务', async () => {
  cli.writeRaw('');
  cli.writeRaw('   ');
  cli.writeRaw('123');
  cli.writeRaw('"just a string"');
  cli.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 8888, result: { pretending: 'to be a response' } }));
  await new Promise((r) => setTimeout(r, 250));
  const res = await cli.request('tools/list');
  assert.strictEqual(res.result.tools.length, 5);
});

s.test('批量请求（数组）得到数组响应', async () => {
  const before = cli.unsolicited.length;
  cli.writeRaw(
    JSON.stringify([
      { jsonrpc: '2.0', id: 7001, method: 'ping' },
      { jsonrpc: '2.0', id: 7002, method: 'tools/list' },
    ])
  );
  await new Promise((r) => setTimeout(r, 400));
  const got = cli.unsolicited.slice(before);
  const ids = got.map((m) => m.id).sort();
  assert.deepStrictEqual(ids, [7001, 7002], `应收到两条响应，实际 ${JSON.stringify(got)}`);
});

s.test('多个请求并发时 id 不会串', async () => {
  const [a, b, c] = await Promise.all([cli.request('ping'), cli.request('tools/list'), callTool('ocr_image', { image_path: 'nope.png' })]);
  assert.deepStrictEqual(a.result, {});
  assert.ok(b.result.tools);
  assert.strictEqual(c.result.isError, true);
});

s.test('全程 stdout 只有合法 JSON-RPC（日志不能污染协议通道）', () => {
  assert.deepStrictEqual(cli.badLines, [], `stdout 出现了非 JSON 内容：${cli.badLines.slice(0, 3).join(' | ')}`);
});

s.test('经历上述所有错误后进程仍然存活', () => {
  assert.strictEqual(cli.exited, null, `服务器已退出：${JSON.stringify(cli.exited)}；stderr 尾部：${cli.stderr.slice(-500)}`);
});

s.test('stdin 关闭后进程自行优雅退出（不留僵尸）', async () => {
  const c = new MCPClient().start();
  await c.handshake();
  c.child.stdin.end();
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 3000);
    c.child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  assert.strictEqual(code, 0, `期望退出码 0，实际 ${code}`);
});

module.exports = s;
if (require.main === module) s.main();

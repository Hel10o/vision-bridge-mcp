#!/usr/bin/env node
/**
 * 不经过 MCP，直接打视觉 API 做一次 OCR —— 用于隔离问题：
 * 「到底是 MCP 桥接层有问题，还是服务商本身就返回不了？」
 *
 * 用法：
 *   node examples/direct-ocr.js <图片路径> ["提示词"] [--max-tokens 8192]
 *
 * 配置来源（按优先级）：环境变量 VISION_* → ~/.zcode/cli/config.json 里 vision-bridge 的 env。
 *
 * 日常识图不需要这个脚本，用服务器自带的 CLI 更省事：
 *   node server.js --call ocr_image --image <图片路径>
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const argv = process.argv.slice(2);
const pick = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] || '').startsWith('--'));

const IMAGE = positional[0];
const PROMPT =
  positional[1] ||
  '请精确转录这张图片中的全部文字，不要遗漏、不要改写；数学公式用 LaTeX 表达；转录完后描述图中的非文字元素（电路图、表格等）。';
const MAX_TOKENS = parseInt(pick('--max-tokens', process.env.VISION_MAX_TOKENS || '4096'), 10);

function loadEnv() {
  if (process.env.VISION_API_KEY) {
    return {
      VISION_API_KEY: process.env.VISION_API_KEY,
      VISION_API_BASE: process.env.VISION_API_BASE,
      VISION_MODEL: process.env.VISION_MODEL,
    };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8'));
    return (cfg.mcp && cfg.mcp.servers && cfg.mcp.servers['vision-bridge'] && cfg.mcp.servers['vision-bridge'].env) || {};
  } catch (e) {
    console.error(`读取 ~/.zcode/cli/config.json 失败：${e.message}`);
    return {};
  }
}

function callVision(env, dataUrl, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: env.VISION_MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      max_tokens: maxTokens,
      stream: false,
    });
    const base = (env.VISION_API_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
    const url = new URL(base + '/chat/completions');
    // 原版这里漏了 require('http')，遇到 http:// 的本地服务会直接 ReferenceError
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.VISION_API_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

(async () => {
  if (!IMAGE) {
    console.error('用法: node examples/direct-ocr.js <图片路径> ["提示词"] [--max-tokens 8192]');
    process.exit(2);
  }
  const env = loadEnv();
  if (!env.VISION_API_KEY) {
    console.error('未配置 VISION_API_KEY（环境变量和 ~/.zcode/cli/config.json 里都没有）');
    process.exit(2);
  }

  const file = path.resolve(IMAGE);
  if (!fs.existsSync(file)) {
    console.error(`图片不存在: ${file}`);
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  // 按 magic bytes 判类型，别信扩展名
  const mime =
    buf[0] === 0x89 && buf[1] === 0x50
      ? 'png'
      : buf[0] === 0xff && buf[1] === 0xd8
        ? 'jpeg'
        : buf.toString('latin1', 0, 4) === 'RIFF'
          ? 'webp'
          : buf.toString('latin1', 0, 3) === 'GIF'
            ? 'gif'
            : 'png';
  const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
  console.log(
    `图片: ${file}\n类型: ${mime} | 原文件 ${(buf.length / 1024).toFixed(1)}KB → base64 ${(dataUrl.length / 1024).toFixed(1)}KB\n` +
      `模型: ${env.VISION_MODEL} @ ${env.VISION_API_BASE}\nmax_tokens: ${MAX_TOKENS}\n`
  );

  const t0 = Date.now();
  const { status, body } = await callVision(env, dataUrl, PROMPT, MAX_TOKENS);
  console.log(`HTTP ${status}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  if (status !== 200) {
    console.log('错误响应:', body.slice(0, 800));
    process.exit(1);
  }

  const j = JSON.parse(body);
  const choice = (j.choices && j.choices[0]) || {};
  const text = choice.message && choice.message.content;
  console.log('\n===== OCR 结果 =====\n');
  console.log(text || '(空)');
  if (choice.finish_reason === 'length') {
    console.log(`\n⚠️ finish_reason=length：输出在 ${MAX_TOKENS} tokens 处被截断，上面的内容不完整。加大 --max-tokens 再试。`);
  }
  if (j.usage) console.log(`\n[usage] in=${j.usage.prompt_tokens} out=${j.usage.completion_tokens} total=${j.usage.total_tokens}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});

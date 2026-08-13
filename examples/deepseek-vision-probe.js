#!/usr/bin/env node
/**
 * 实测 DeepSeek 官方 API（anthropic 兼容端点）是否真正识别图片内容。
 * 与 ZCode 客户端行为保持一致：POST /anthropic/v1/messages，image block 走 base64。
 *
 * 用法：
 *   node test-deepseek-vision.js [model1 model2 ...] [--image <path|url>] [--prompt <text>]
 * 默认测试 deepseek-v4-pro 和 deepseek-v4-flash；默认图片为程序生成的 4x4 纯红 PNG。
 * API Key 默认从 ~/.zcode/v2/config.json 读取（与客户端同源），可用 DEEPSEEK_API_KEY 覆盖。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

// ---------- 参数解析 ----------

const argv = process.argv.slice(2);
const pick = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FLAGS = new Set(['--image', '--prompt', '--max-tokens']);
const MODELS = argv.filter((a, i) => !a.startsWith('-') && !FLAGS.has(argv[i - 1])).length
  ? argv.filter((a, i) => !a.startsWith('-') && !FLAGS.has(argv[i - 1]))
  : ['deepseek-v4-pro', 'deepseek-v4-flash'];
const IMAGE_ARG = pick('--image'); // 本地路径或 URL
const PROMPT = pick('--prompt') || '仔细看这张图片，告诉我：1) 图片里有什么；2) 主色调是什么。用中文回答。';
const MAX_TOKENS = parseInt(pick('--max-tokens') || '300', 10);

const BASE = 'https://api.deepseek.com/anthropic';

// ---------- API Key（与客户端同源） ----------

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cfgPath = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const p of Object.values(cfg.provider || {})) {
      if (p.options && p.options.baseURL && p.options.baseURL.includes('deepseek.com') && p.options.apiKey) {
        return p.options.apiKey;
      }
    }
  } catch (e) {
    console.error('读取 config.json 失败:', e.message);
  }
  return '';
}

// ---------- 生成 4x4 纯红 PNG（zlib 构造） ----------

function makeRedPng(w = 4, h = 4) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const scanlines = [];
  for (let y = 0; y < h; y++) {
    scanlines.push(Buffer.from([0]));
    for (let x = 0; x < w; x++) scanlines.push(Buffer.from([255, 0, 0, 255]));
  }
  const idat = zlib.deflateSync(Buffer.concat(scanlines));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 定位图片 -> base64 data URL ----------

function resolveImage() {
  if (!IMAGE_ARG) {
    const png = makeRedPng();
    return { label: '内置 4x4 纯红 PNG', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  }
  if (/^https?:\/\//i.test(IMAGE_ARG)) {
    return { label: 'URL ' + IMAGE_ARG, source: { type: 'url', url: IMAGE_ARG } };
  }
  const p = path.resolve(IMAGE_ARG);
  if (!fs.existsSync(p)) throw new Error('图片文件不存在: ' + p);
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase().replace('.', '');
  const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' }[ext] || 'png';
  console.log(`    （图片 ${p}，${(buf.length / 1024).toFixed(1)} KB）`);
  return { label: p, source: { type: 'base64', media_type: `image/${mime}`, data: buf.toString('base64') } };
}

// ---------- 发送 anthropic messages 请求 ----------

function callVision(apiKey, model, imageSource) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: imageSource },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    const req = https.request(
      BASE + '/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          Authorization: 'Bearer ' + apiKey,
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
    req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

// ---------- 主流程 ----------

(async () => {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('✗ 未找到 DeepSeek API Key（可在 ~/.zcode/v2/config.json 或 DEEPSEEK_API_KEY 提供）');
    process.exit(1);
  }
  const img = resolveImage();
  console.log(`✓ 已加载 DeepSeek API Key（${apiKey.slice(0, 6)}...）`);
  console.log(`✓ 测试图片: ${img.label}\n`);

  for (const model of MODELS) {
    try {
      const { status, body } = await callVision(apiKey, model, img.source);
      console.log(`=== ${model} ===`);
      console.log(`HTTP ${status}`);
      if (status === 200) {
        const j = JSON.parse(body);
        const text = (j.content || [])
          .map((c) => (c.type === 'text' ? c.text : c.type === 'thinking' ? `[thinking] ${c.thinking}` : JSON.stringify(c)))
          .join('\n');
        console.log('  模型输出:');
        console.log('  ' + text.replace(/\n/g, '\n  '));
        console.log(`  （usage: input=${j.usage && j.usage.input_tokens} output=${j.usage && j.usage.output_tokens}）`);
      } else {
        console.log(`✗ 拒绝图片输入: ${body.slice(0, 400)}`);
      }
      console.log('');
    } catch (e) {
      console.log(`=== ${model} ===`);
      console.log(`✗ 请求失败: ${e.message}\n`);
    }
  }
})();

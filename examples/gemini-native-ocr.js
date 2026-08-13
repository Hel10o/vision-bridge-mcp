#!/usr/bin/env node
/**
 * 用 Gemini 原生端点（generateContent）做 OCR，可关闭 thinking 获得完整输出。
 * 用法：node test-gemini-native.js <图片路径> "<提示词>"
 * Key 从 ~/.zcode/cli/config.json 读取；走 HTTPS_PROXY 环境变量代理。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const IMAGE = process.argv[2];
const PROMPT = process.argv[3] || '请精确转录图片中的全部文字。';

function loadEnv() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8'));
  return cfg.mcp.servers['vision-bridge'].env;
}

const env = loadEnv();
const MODEL = env.VISION_MODEL || 'gemini-3.5-flash';
const API_KEY = env.VISION_API_KEY || '';

function callNative(apiKey, dataUrl, prompt) {
  return new Promise((resolve, reject) => {
    const mime = dataUrl.split(';')[0].split(':')[1];
    const b64 = dataUrl.split(',')[1];
    const body = JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: b64 } },
          ],
        },
      ],
      generationConfig: {
        thinkingConfig: { includeThoughts: false },
        maxOutputTokens: 8192,
      },
    });

    const req = https.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
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
    req.setTimeout(180000, () => req.destroy(new Error('超时')));
    req.end(body);
  });
}

(async () => {
  if (!IMAGE || !API_KEY) { console.error('用法: node test-gemini-native.js <图片> [提示词]（需 config.json 已配置）'); process.exit(1); }
  const buf = fs.readFileSync(path.resolve(IMAGE));
  const ext = path.extname(IMAGE).toLowerCase().replace('.', '');
  const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', bmp: 'bmp' }[ext] || 'png';
  console.log(`图片: ${IMAGE} (${(buf.length / 1024).toFixed(1)} KB), 模型: ${MODEL}（原生端点，thinking 已关）`);

  const { status, body } = await callNative(API_KEY, `data:image/${mime};base64,${buf.toString('base64')}`, PROMPT);
  console.log(`HTTP ${status}`);
  if (status !== 200) { console.log('错误响应:', body.slice(0, 800)); process.exit(1); }

  const j = JSON.parse(body);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
  console.log('\n===== 识别结果 =====\n');
  console.log(text || '(空)');
  console.log(`\n[finishReason: ${j.candidates && j.candidates[0] && j.candidates[0].finishReason}]`);
})();

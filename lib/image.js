'use strict';

/**
 * 图片定位与编码。
 * 三件事最容易出问题，这里逐个兜住：
 *  1. 路径 —— 模型给的路径千奇百怪（相对路径 / ~ / file:// / 带引号 / 反斜杠 / latest）
 *  2. 格式 —— 扩展名不可信，一律读前 12 字节判 magic bytes
 *  3. 体积 —— API 收的是 base64（约为原文件 1.33 倍），所以按 base64 后的字节数卡上限
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const nodeUrl = require('url');

const { VisionError } = require('./errors');

/** 各家视觉 API 普遍支持的格式 */
const SUPPORTED = new Set(['png', 'jpeg', 'gif', 'webp', 'bmp']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const LATEST_WORDS = new Set([
  'latest',
  'last',
  'newest',
  'recent',
  'clipboard',
  'paste',
  'pasted',
  'latest_image',
  'latest-image',
  '最新',
  '最新图片',
  '最新的图片',
  '刚才的图片',
  '刚粘贴的图片',
  '粘贴',
  '粘贴的图片',
  '剪贴板',
]);

// ---------- magic bytes ----------

function ascii(buf, start, end) {
  return buf.length >= end ? buf.toString('latin1', start, end) : '';
}

/**
 * 读文件头判断真实类型。返回 { mime, supported, label }，无法识别返回 null。
 */
function sniffMime(buf) {
  if (!buf || buf.length < 2) return null;
  const b = buf;

  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return ok('png');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ok('jpeg');
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return ok('gif');
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return ok('webp');
  if (b[0] === 0x42 && b[1] === 0x4d) return ok('bmp');

  // ISO-BMFF 家族（HEIC / AVIF）：偏移 4 起是 'ftyp'
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase();
    if (['avif', 'avis'].includes(brand)) return bad('avif', 'AVIF');
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand))
      return bad('heic', 'HEIC/HEIF（iPhone 默认格式）');
    return bad(brand || 'isobmff', `ISO-BMFF 容器（brand=${brand}）`);
  }

  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    return bad('tiff', 'TIFF');
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return bad('x-icon', 'ICO 图标');
  if (ascii(b, 0, 4) === '%PDF') return bad('pdf', 'PDF 文档');
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return bad('zip', 'ZIP/Office 压缩包');

  const head = b.toString('utf8', 0, Math.min(b.length, 200)).trimStart();
  if (/^<(\?xml|svg)/i.test(head)) return bad('svg+xml', 'SVG 矢量图');

  return null;

  function ok(mime) {
    return { mime, supported: true, label: mime.toUpperCase() };
  }
  function bad(mime, label) {
    return { mime, supported: false, label };
  }
}

// ---------- 路径归一化 ----------

function isAbsolutish(p) {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 把模型给的字符串收拾成一个能用的路径形式：
 * 去引号/反引号/尖括号、file:// 解码、%VAR%/$VAR/~ 展开、/c/Users 风格盘符还原。
 */
function expandRaw(input) {
  let p = String(input === undefined || input === null ? '' : input).trim();
  if (!p) return '';

  p = p.replace(/^[\s`'"<([]+/, '').replace(/[\s`'">)\]]+$/, '').trim();
  if (!p) return '';

  if (/^file:\/\//i.test(p)) {
    try {
      p = nodeUrl.fileURLToPath(p);
    } catch {
      p = decodeURIComponent(p.replace(/^file:\/+/i, process.platform === 'win32' ? '' : '/'));
    }
  }

  p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m));
  p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => (process.env[n] !== undefined ? process.env[n] : m));

  if (p === '~') p = os.homedir();
  else p = p.replace(/^~(?=[\\/])/, os.homedir());

  if (process.platform === 'win32') {
    const m = /^\/(?:mnt\/)?([A-Za-z])\/(.*)$/.exec(p);
    if (m) p = `${m[1]}:/${m[2]}`;
  }
  return p;
}

function isLatestKeyword(p) {
  return LATEST_WORDS.has(String(p).trim().toLowerCase());
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isFile(p) {
  const st = statSafe(p);
  return !!st && st.isFile();
}

/** 相对路径的候选目录（MCP 进程的 cwd 通常不是用户的项目目录，所以要多试几处） */
function pathCandidates(p, config) {
  const out = [];
  const add = (x) => {
    const r = path.resolve(x);
    if (!out.includes(r)) out.push(r);
  };
  if (isAbsolutish(p)) {
    add(p);
    return out;
  }
  for (const d of config.searchDirs) {
    try {
      add(path.resolve(expandRaw(d), p));
    } catch {
      /* 跳过非法目录 */
    }
  }
  for (const d of config.pasteDirs) {
    try {
      add(path.resolve(expandRaw(d), p));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 在若干目录下按文件名浅层递归查找，带扫描上限，防止误扫大目录 */
function findByName(name, dirs, maxDepth = 2, budget = 4000) {
  const target = name.toLowerCase();
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || scanned > budget) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const subdirs = [];
    for (const e of entries) {
      if (++scanned > budget) return null;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') subdirs.push(path.join(dir, e.name));
      } else if (e.name.toLowerCase() === target) {
        return path.join(dir, e.name);
      }
    }
    for (const sd of subdirs) {
      const hit = walk(sd, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const d of dirs) {
    const hit = walk(path.resolve(expandRaw(d)), 0);
    if (hit) return hit;
  }
  return null;
}

/** 找最近落盘的图片：客户端把对话里粘贴的图片写在 pasteDirs 下 */
function findLatestImage(dirs, maxDepth = 3, budget = 6000) {
  let best = null;
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || scanned > budget) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++scanned > budget) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
      } else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        const st = statSafe(full);
        if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { file: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  for (const d of dirs) walk(path.resolve(expandRaw(d)), 0);
  return best;
}

// ---------- 目录白名单 ----------

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(dir, file) {
  const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const rel = path.relative(norm(dir), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertAllowed(file, config) {
  if (!config.allowedDirs || !config.allowedDirs.length) return;
  const real = realpathSafe(file);
  const ok = config.allowedDirs.some((d) => isInside(realpathSafe(expandRaw(d)), real));
  if (!ok) {
    throw new VisionError(`路径不在 VISION_ALLOWED_DIRS 白名单内：${file}`, {
      code: 'path_not_allowed',
      hint: `当前只允许读取：${config.allowedDirs.join('、')}。请把图片放进这些目录，或让用户调整 VISION_ALLOWED_DIRS。`,
    });
  }
}

// ---------- 定位 + 读取 ----------

/** 返回绝对路径；失败时抛出带“试过哪些位置”的 VisionError，方便模型自己改参数重试 */
function resolveLocalFile(input, config) {
  const p = expandRaw(input);
  if (!p) {
    throw new VisionError('image_path 是空字符串', { code: 'empty_path', hint: '给出图片的绝对路径，或用 image_path="latest" 取最近粘贴/保存的图片。' });
  }

  if (isLatestKeyword(p)) {
    const latest = findLatestImage(config.pasteDirs) || findLatestImage(config.searchDirs.filter((d) => /screenshot|截图|Pictures|Desktop/i.test(d)), 1);
    if (!latest) {
      throw new VisionError('没找到最近的图片', {
        code: 'no_latest_image',
        hint: `已扫描：${config.pasteDirs.join('、')}。请让用户重新粘贴图片，或直接给出图片的绝对路径。`,
      });
    }
    return { file: latest.file, via: 'latest', mtimeMs: latest.mtimeMs };
  }

  const tried = pathCandidates(p, config);
  for (const c of tried) {
    const st = statSafe(c);
    if (st && st.isFile()) return { file: c, via: isAbsolutish(p) ? 'absolute' : 'search-dir', mtimeMs: st.mtimeMs };
    if (st && st.isDirectory()) {
      throw new VisionError(`这是一个目录，不是图片文件：${c}`, {
        code: 'is_directory',
        hint: '请给出具体的图片文件路径（含扩展名）。',
      });
    }
  }

  // 只给了文件名时，去粘贴目录/截图目录里搜一把
  const base = path.basename(p);
  if (base && base !== p) {
    const hit = findByName(base, config.pasteDirs, 2);
    if (hit) return { file: hit, via: 'name-search', mtimeMs: (statSafe(hit) || {}).mtimeMs };
  } else {
    const hit = findByName(base, [...config.pasteDirs, ...config.searchDirs.slice(0, 6)], 1);
    if (hit) return { file: hit, via: 'name-search', mtimeMs: (statSafe(hit) || {}).mtimeMs };
  }

  const shown = tried.slice(0, 6);
  throw new VisionError(`图片文件不存在：${p}`, {
    code: 'file_not_found',
    details: { tried: shown },
    hint:
      `已尝试这些位置都没有：\n${shown.map((t) => '  - ' + t).join('\n')}\n` +
      '请改用图片的完整绝对路径（Windows 形如 C:/Users/名字/Pictures/a.png）；' +
      '如果这张图是用户刚粘贴到对话里的，直接传 image_path="latest"。',
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 粗判是不是文本（中文等多字节内容也算），用于给出“这是文本不是图片”的提示 */
function looksLikeText(buf) {
  const sample = buf.subarray(0, Math.min(512, buf.length));
  if (sample.includes(0)) return false; // 二进制通常带 NUL
  const chars = Array.from(sample.toString('utf8'));
  if (!chars.length) return false;
  let printable = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffd)) printable++;
  }
  return printable / chars.length > 0.9;
}

/** 读本地图片 → data URL（含格式与体积校验） */
function loadLocalImage(input, config) {
  const { file, via, mtimeMs } = resolveLocalFile(input, config);
  assertAllowed(file, config);

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    throw new VisionError(`读取图片失败：${file}（${e.code || e.message}）`, {
      code: 'read_failed',
      hint: e.code === 'EACCES' ? '文件没有读权限，换一个位置或调整权限后重试。' : '确认文件没有被其它程序独占，然后重试。',
    });
  }

  if (!buf.length) {
    throw new VisionError(`图片文件是空的（0 字节）：${file}`, { code: 'empty_file', hint: '这张图可能没保存成功，请重新截图或换一张。' });
  }

  const sniff = sniffMime(buf);
  if (!sniff) {
    const hex = buf.toString('hex', 0, Math.min(12, buf.length)).replace(/(..)/g, '$1 ').trim();
    const looksText = looksLikeText(buf);
    throw new VisionError(`文件不是可识别的图片（前 12 字节：${hex}）：${file}`, {
      code: 'not_an_image',
      hint: looksText
        ? `这看起来是文本文件，内容开头是「${buf.toString('utf8', 0, Math.min(80, buf.length)).replace(/\s+/g, ' ')}」。如果要读文本，请用文件读取工具而不是识图工具。`
        : '请确认这是 PNG/JPEG/GIF/WEBP/BMP 图片；扩展名对不代表内容对。',
    });
  }

  if (!sniff.supported) {
    throw new VisionError(`不支持的图片格式：${sniff.label}（${file}）`, {
      code: 'unsupported_format',
      hint: `视觉 API 只吃 PNG / JPEG / GIF / WEBP / BMP。请先把这张 ${sniff.label} 转成 PNG 或 JPEG 再调用。`,
    });
  }

  const base64 = buf.toString('base64');
  const limitBytes = Math.floor(config.maxImageMB * 1024 * 1024);
  if (base64.length > limitBytes) {
    throw new VisionError(
      `图片编码后 ${(base64.length / 1024 / 1024).toFixed(2)}MB，超过上限 ${config.maxImageMB}MB（原文件 ${(buf.length / 1024 / 1024).toFixed(2)}MB，base64 会放大约 1.33 倍）`,
      {
        code: 'image_too_large',
        hint:
          '请压缩图片、截取关键区域，或分成几张小图分别识别。' +
          `如果服务商允许更大的图，可以调高环境变量 VISION_MAX_IMAGE_MB（当前 ${config.maxImageMB}）。`,
      }
    );
  }

  return {
    kind: 'path',
    id: `sha256:${sha256(buf)}`,
    file,
    via,
    mtimeMs,
    mime: `image/${sniff.mime}`,
    base64,
    dataUrl: `data:image/${sniff.mime};base64,${base64}`,
    bytes: buf.length,
    payloadBytes: base64.length,
  };
}

function loadRemoteImage(input) {
  const raw = String(input).trim().replace(/^[`'"<([]+/, '').replace(/[`'">)\]]+$/, '');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new VisionError(`image_url 不是合法 URL：${raw}`, {
      code: 'bad_url',
      hint: '如果这是本机文件，请改用 image_path 参数。',
    });
  }
  if (u.protocol === 'file:') {
    let asPath = raw;
    try {
      asPath = nodeUrl.fileURLToPath(raw);
    } catch {
      asPath = expandRaw(raw); // Windows 上没有盘符的 file:/// 会解析失败，退回文本处理
    }
    throw new VisionError('file:// 地址请用 image_path 参数传入', { code: 'bad_url', hint: `改成 image_path="${asPath}"` });
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new VisionError(`不支持的 URL 协议：${u.protocol}`, { code: 'bad_url', hint: '只支持 http/https，本机文件请用 image_path。' });
  }
  return { kind: 'url', id: `url:${u.href}`, url: u.href, dataUrl: u.href, mime: 'image/*', bytes: 0, payloadBytes: 0 };
}

/**
 * 把工具参数里的各种写法收敛成图片列表。
 * 支持 image_path / image_paths / image_url / image_urls，以及模型常自己编的别名。
 */
function collectImages(args, config) {
  const pick = (...names) => {
    const vals = [];
    for (const n of names) {
      const v = args[n];
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) vals.push(...v.filter((x) => x !== undefined && x !== null && x !== ''));
      else vals.push(v);
    }
    return vals.map((v) => String(v));
  };

  const paths = pick('image_path', 'image_paths', 'path', 'paths', 'file', 'files', 'image', 'images', 'imagePath', 'image_file');
  const urls = pick('image_url', 'image_urls', 'url', 'urls', 'imageUrl');

  // 有人会把 http 地址塞进 image_path，也有人把本地路径塞进 image_url，这里互相纠正
  const realPaths = [];
  const realUrls = [...urls.filter((u) => /^(https?:)?\/\//i.test(u))];
  for (const p of paths) {
    if (/^https?:\/\//i.test(p)) realUrls.push(p);
    else realPaths.push(p);
  }
  for (const u of urls) {
    if (!/^(https?:)?\/\//i.test(u)) realPaths.push(u);
  }

  if (!realPaths.length && !realUrls.length) {
    throw new VisionError('没有提供图片', {
      code: 'no_image',
      hint:
        '必须传 image_path（本机图片绝对路径）或 image_url（http/https 图片地址）之一；' +
        '多张图用 image_paths / image_urls 数组。若图片是用户刚粘贴到对话里的，传 image_path="latest"。',
    });
  }

  const total = realPaths.length + realUrls.length;
  if (total > config.maxImages) {
    throw new VisionError(`一次最多 ${config.maxImages} 张图片，收到 ${total} 张`, {
      code: 'too_many_images',
      hint: '请分批调用，或调高 VISION_MAX_IMAGES。',
    });
  }

  const images = [];
  for (const p of realPaths) images.push(loadLocalImage(p, config));
  for (const u of realUrls) images.push(loadRemoteImage(u));
  return images;
}

module.exports = {
  sniffMime,
  looksLikeText,
  expandRaw,
  isLatestKeyword,
  isAbsolutish,
  isInside,
  pathCandidates,
  findByName,
  findLatestImage,
  resolveLocalFile,
  assertAllowed,
  loadLocalImage,
  loadRemoteImage,
  collectImages,
  sha256,
  SUPPORTED,
  LATEST_WORDS,
};

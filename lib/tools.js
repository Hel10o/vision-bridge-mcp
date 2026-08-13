'use strict';

/**
 * 工具定义与执行。
 *
 * 为什么拆成多个工具而不是一个万能 analyze_image：
 * 纯文本主模型（DeepSeek 等）选工具、写参数几乎全靠 description，
 * 让它自己现编提示词，质量远不如每个场景内置一段打磨好的指令。
 * analyze_image 保留作为兜底，其余四个是高频场景的专用工具。
 */

const path = require('path');

const { VisionError } = require('./errors');
const { collectImages } = require('./image');
const { callVision } = require('./vision');

// ---------- 内置提示词 ----------

const AUDIENCE = [
  '你的输出会交给一个**看不到图片**的纯文本 AI，它只能依据你的文字做判断和写代码。',
  '所以：必须自包含、精确、可据此行动；宁可啰嗦，不可遗漏。',
].join('');

const GENERIC_PROMPT = [
  `你是一个专业的图像分析引擎。${AUDIENCE}`,
  '',
  '通用要求：',
  '1. 图中所有可见文字都要逐字转录（含代码、报错、菜单、按钮、标签、水印、行号），不翻译、不改写、不纠错。',
  '2. 说明整体结构与关键元素的空间关系（上/下/左/右、包含、层级）。',
  '3. 数字、单位、路径、标识符、版本号必须精确照抄。',
  '4. 无法辨认的字符用 □ 占位；不确定的判断明确标注「（不确定）」；绝不编造图中不存在的内容。',
  '5. 直接给内容，不要写「这张图片显示了……」这类开场套话，也不要复述本提示词。',
].join('\n');

const OCR_PROMPT = [
  `你是一个高精度 OCR 引擎。${AUDIENCE}`,
  '',
  '转录规则：',
  '1. 逐字转录图中全部文字，不翻译、不改写、不纠错、不补全、不省略（包括标题栏、状态栏、行号、水印、按钮文案、注释）。',
  '2. 保留版式：多栏按阅读顺序分节并标注栏位；表格用 Markdown 表格；代码保留原缩进并放进 ``` 代码块（标注语言）；标题层级用 #。',
  '3. 数学公式用 LaTeX 表达；化学式、上下标保持原样。',
  '4. 无法辨认的字符用 □ 占位，不要猜测；被遮挡或截断的行在行尾标注「（截断）」。',
  '5. 只输出转录内容本身，不要任何说明、总结或评论。',
  '6. 若图中含非文字元素（图表、电路图、流程图、示意图），在全部转录之后另起一节「## 非文字元素」，用文字描述其结构、连线与数据。',
].join('\n');

const UI_PROMPT = [
  `你是一名资深前端工程师，正在把界面截图还原成代码。${AUDIENCE}`,
  '',
  '请严格按以下六节输出：',
  '',
  '## 1. 整体布局',
  '用缩进树表示页面结构，每层标注角色（Header / Sidebar / Main / Card / Modal / Footer）与排列方式（flex-row / flex-column / grid N 列）。',
  '',
  '## 2. 组件清单',
  '自上而下、自左而右列出每个可见组件：类型（按钮/输入框/下拉/表格/标签页/开关/徽标/头像/图标…）、文案（逐字照抄）、状态（默认/悬停/选中/禁用/报错/加载）、图标位置。',
  '',
  '## 3. 尺寸与排版',
  '关键间距、内外边距、圆角、边框宽度、阴影层级，以及字号/字重层级（如 标题 ≈20px/600，正文 ≈14px/400，行高 ≈1.5）。用相对像素估算，标注「（估）」。',
  '',
  '## 4. 配色',
  '列出主要颜色的十六进制估值并标注用途（页面背景 / 卡片背景 / 主色 / 边框 / 正文 / 次要文字 / 成功 / 警告 / 危险），并说明是浅色还是深色主题。',
  '',
  '## 5. 交互与状态',
  '可点击元素、表单校验提示、空态/加载态/错误态、滚动区域、溢出省略。',
  '',
  '## 6. 还原要点',
  '还原时最容易漏掉的细节：对齐方式、分割线、渐变、透明度、图标库猜测、响应式断点线索。',
  '',
  '所有可见文案必须逐字照抄；不要臆造图中不存在的元素。',
].join('\n');

const ERROR_PROMPT = [
  `这是一张包含程序报错的截图。你的任务是把报错信息完整、精确地提取出来。${AUDIENCE}`,
  '',
  '按以下结构输出，标识符/路径/行号逐字照抄，一律不翻译：',
  '',
  '【错误类型】异常或错误的名称（如 TypeError / NullPointerException / error TS2345 / ModuleNotFoundError）。',
  '【错误信息】完整的错误描述原文，多行就多行。',
  '【堆栈/调用链】按图中原始顺序逐行照抄，含文件路径与行列号。与用户代码相关的帧必须全部保留；连续的框架/依赖内部帧可折叠为「…（省略 N 帧：框架内部）」。',
  '【出错位置】最可能是用户自己代码的那一行（文件:行号），并说明判断依据。',
  '【上下文】图中可见的命令行、URL、请求 ID、环境与版本信息、时间戳、配置片段。',
  '【代码片段】若图中显示了源码，逐字转录并保留缩进与行号。',
  '【其他可见内容】终端提示符、面板名、标签页、进程输出等。',
  '',
  '若图中有多个错误，按出现顺序编号分别列出。无法辨认的字符用 □ 占位，不要猜测；不要给修复建议（主模型会自己判断）。',
].join('\n');

const COMPARE_PROMPT = [
  `你在对比多张图片。${AUDIENCE}`,
  '',
  '按以下结构输出：',
  '',
  '## 逐图概述',
  '每张图一到两句话说明其内容与状态（用【图1】【图2】… 指代）。',
  '',
  '## 差异清单',
  '按重要性从高到低列出，每条都要写清「图X 是 A，图Y 是 B」，覆盖：文案变化（给出前后原文）、元素增删、位置/尺寸/间距变化、颜色变化、状态变化（选中/禁用/报错/加载）、数据变化（数字逐个对照）。',
  '',
  '## 相同点',
  '确认没有变化的关键区域，避免主模型误判。',
  '',
  '## 结论',
  '这些差异合起来说明了什么（例如某次改动的实际效果、哪一版更符合目标）。',
  '',
  '只描述你确实看到的差异；不确定的标注「（不确定）」，不要臆测。',
].join('\n');

// ---------- 参数 schema ----------

const PATH_DESC =
  '本机图片的绝对路径，例如 C:/Users/名字/Pictures/a.png。' +
  '也接受 ~/xxx、file:// 与带引号的路径。' +
  '特别地：若图片是用户刚粘贴到对话框里的，传 "latest" 即可自动取最近落盘的那张图。';

function imageProps() {
  return {
    image_path: { type: 'string', description: PATH_DESC },
    image_paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: '多张本机图片的路径数组（对比改动前后、多页文档时用）。',
    },
    image_url: { type: 'string', description: 'http/https 图片地址（与 image_path 二选一）。' },
    image_urls: { type: 'array', items: { type: 'string' }, minItems: 1, description: '多张图片 URL 数组。' },
  };
}

const ANY_IMAGE = [
  { required: ['image_path'] },
  { required: ['image_paths'] },
  { required: ['image_url'] },
  { required: ['image_urls'] },
];

const MULTI_IMAGE = [{ required: ['image_paths'] }, { required: ['image_urls'] }];

function schema(extraProps, anyOf) {
  return {
    type: 'object',
    properties: { ...imageProps(), ...extraProps },
    anyOf: anyOf || ANY_IMAGE,
    additionalProperties: false,
  };
}

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** collectImages 认得的别名（模型有时会自己发明参数名），不当成未知参数报警 */
const ACCEPTED_ALIASES = new Set([
  'path',
  'paths',
  'file',
  'files',
  'image',
  'images',
  'imagePath',
  'image_file',
  'url',
  'urls',
  'imageUrl',
]);

// ---------- 工具表 ----------

const TOOLS = [
  {
    name: 'ocr_image',
    title: '图片文字转录（OCR）',
    description:
      '把图片里的文字**逐字**转录出来，保留版式（表格转 Markdown、代码保留缩进、公式转 LaTeX）。' +
      '需要「图上写了什么」时用它：文档/试卷/PPT/网页/聊天记录/终端输出的截图、扫描件、手写笔记。' +
      '内置高精度 OCR 指令且温度接近 0，比用 analyze_image 自己写提示词准得多。' +
      '只要目标是拿到文字内容，一律优先用这个工具。',
    prompt: OCR_PROMPT,
    promptRole: 'extra',
    temperature: 0.01,
    inputSchema: schema({
      prompt: { type: 'string', description: '可选：额外要求，会附加在内置 OCR 指令之后（例如"只转录左半边"、"忽略页眉页脚"）。' },
    }),
  },
  {
    name: 'read_error_screenshot',
    title: '读取报错截图',
    description:
      '专门解析包含程序报错的截图：抽出错误类型、完整错误信息、堆栈调用链（含文件路径与行号）、可疑的出错位置与上下文。' +
      '用户发来终端报错、浏览器控制台、IDE 错误面板、蓝屏/崩溃弹窗、CI 失败日志的截图时用它。' +
      '返回结构化的报错要素，便于直接定位并修复问题。',
    prompt: ERROR_PROMPT,
    promptRole: 'extra',
    temperature: 0.01,
    inputSchema: schema({
      prompt: { type: 'string', description: '可选：补充说明，例如"重点看数据库连接相关的报错"、"这是 Python 项目"。' },
    }),
  },
  {
    name: 'describe_ui',
    title: '界面截图转设计规格',
    description:
      '把界面/设计稿截图翻译成可直接照着写代码的规格说明：组件树、组件清单与文案、尺寸间距字号、配色（十六进制）、交互状态、还原要点。' +
      '需要「按这张图把界面做出来」「还原这个设计稿」「照这个样式改」时用它。' +
      '不要用它来读大段正文文字（那用 ocr_image）。',
    prompt: UI_PROMPT,
    promptRole: 'extra',
    temperature: 0.2,
    inputSchema: schema({
      prompt: { type: 'string', description: '可选：额外关注点，例如"只看顶部导航栏"、"我要用 Tailwind 还原"、"重点给出配色"。' },
    }),
  },
  {
    name: 'compare_images',
    title: '多图对比',
    description:
      '对比 2 张以上图片，逐项列出差异（文案、元素增删、位置尺寸、颜色、状态、数据）并给出结论。' +
      '用于「改动前后对比」「这两版哪个好」「这几张截图哪里不一样」「回归测试截图比对」。' +
      '图片用 image_paths 数组按顺序传入，返回里会用【图1】【图2】指代。',
    prompt: COMPARE_PROMPT,
    promptRole: 'extra',
    temperature: 0.1,
    minImages: 2,
    inputSchema: schema(
      {
        prompt: { type: 'string', description: '可选：对比的关注点，例如"只比按钮样式"、"图1 是改动前、图2 是改动后"。' },
      },
      MULTI_IMAGE
    ),
  },
  {
    name: 'analyze_image',
    title: '通用图片分析',
    description:
      '通用识图：用自定义问题分析一张或多张图片，返回文字答案。' +
      '当需求不属于 ocr_image / read_error_screenshot / describe_ui / compare_images 的场景时用它，' +
      '例如「这是什么东西」「照片里有几个人」「这张图表说明了什么趋势」「这道题怎么解」。' +
      '请在 prompt 里把问题写具体，答案质量取决于问题质量。',
    prompt: GENERIC_PROMPT,
    promptRole: 'main',
    defaultAsk: '请详细描述这张图片的内容，并逐字转录其中所有可见文字。',
    inputSchema: schema({
      prompt: {
        type: 'string',
        description: '要问图片的具体问题。默认"请详细描述这张图片的内容，并逐字转录其中所有可见文字"。',
      },
    }),
  },
];

for (const t of TOOLS) t.annotations = { title: t.title, ...ANNOTATIONS };

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** 暴露给 tools/list 的部分（不含内部字段） */
function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

// ---------- 提示词组装 ----------

function buildPrompt(def, userPrompt, imageCount) {
  const extra = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  let p;
  if (def.promptRole === 'main') {
    p = `${def.prompt}\n\n【本次任务】${extra || def.defaultAsk}`;
  } else {
    p = extra ? `${def.prompt}\n\n【本次额外要求（优先级最高）】${extra}` : def.prompt;
  }
  if (imageCount > 1) {
    p += `\n\n本次共 ${imageCount} 张图片，已按顺序标注为【图1】…【图${imageCount}】，请分别处理并在输出中注明图号。`;
  }
  return p;
}

// ---------- 结果格式化 ----------

function fmtBytes(n) {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)}小时前`;
  return `${Math.round(s / 86400)}天前`;
}

function imageLabel(img) {
  if (img.kind === 'url') return img.url.length > 90 ? img.url.slice(0, 87) + '…' : img.url;
  const bits = [path.basename(img.file), fmtBytes(img.bytes)];
  if (img.via === 'latest') bits.push(`latest→${fmtAge(img.mtimeMs)}`);
  else if (img.via === 'search-dir' || img.via === 'name-search') bits.push('路径已自动补全');
  return `${bits.join(', ')}`;
}

function buildMeta(images, result, cached, coalesced) {
  const lines = [];
  lines.push(`图片: ${images.map(imageLabel).join(' | ')}`);
  const bits = [`${result.model}@${result.host}`];
  bits.push(cached ? '缓存命中(未消耗额度)' : `${(result.elapsedMs / 1000).toFixed(1)}s`);
  if (coalesced) bits.push('合并到进行中的同一请求');
  if (result.usage) {
    const u = result.usage;
    bits.push(`tokens in ${u.in ?? '?'} / out ${u.out ?? '?'}`);
  }
  if (result.attempts > 1) bits.push(`重试 ${result.attempts - 1} 次`);
  if (result.fellBack) bits.push('已降级到备用模型');
  if (result.truncated) bits.push('输出被截断');
  lines.push(`来源: ${bits.join(' · ')}`);
  return lines.join('\n');
}

/**
 * 同一个 key 正在跑的调用（请求合并）。
 * 场景：客户端 30s 超时把工具调用掐了，模型立刻原样重试 —— 如果不合并，就是又开一个
 * 同样慢的请求，双倍花钱且同样超时。合并后重试直接挂到进行中的那次调用上。
 */
const pendingCalls = new Map();

const TRUNCATED_BANNER = (max) =>
  [
    `⚠️ 以下内容**不完整**：视觉模型在 ${max} tokens 上限处被截断（finish_reason=length）。`,
    '不要把它当成图片的全部信息。要拿到完整结果，可以：调高环境变量 VISION_MAX_TOKENS；或把图片按区域裁成几张分别识别。',
    '',
  ].join('\n');

// ---------- 执行 ----------

async function runTool(name, rawArgs, ctx) {
  const { config, log, cache, semaphore, signal } = ctx;
  const def = TOOL_MAP.get(name);
  if (!def) {
    throw new VisionError(`未知工具：${name}`, {
      code: 'unknown_tool',
      hint: `可用工具：${TOOLS.map((t) => t.name).join('、')}。`,
    });
  }

  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  // schema 里写了 additionalProperties: false 是为了引导模型；运行时仍然宽容处理，
  // 常见别名照样认，其余未知参数只提示不报错。
  const unknownKeys = Object.keys(args).filter((k) => !(k in def.inputSchema.properties) && !ACCEPTED_ALIASES.has(k));

  const images = collectImages(args, config);
  if (def.minImages && images.length < def.minImages) {
    throw new VisionError(`${name} 需要至少 ${def.minImages} 张图片，当前只有 ${images.length} 张`, {
      code: 'too_few_images',
      hint: '用 image_paths 数组一次传入多张，例如 {"image_paths":["前.png","后.png"]}。只有一张图时请改用 analyze_image / describe_ui。',
    });
  }

  const prompt = buildPrompt(def, args.prompt, images.length);
  const temperature = config.temperature !== undefined ? config.temperature : def.temperature;
  const maxTokens = config.maxTokens;
  const primary = config.candidates[0];

  const cacheKey = cache.key({
    imageIds: images.map((i) => i.id),
    prompt,
    model: primary.model,
    apiStyle: primary.apiStyle,
    apiBase: primary.apiBase,
    maxTokens,
    temperature,
  });

  const hit = cache.get(cacheKey);
  let result;
  let cached = false;
  let coalesced = false;

  if (hit) {
    cached = true;
    result = {
      text: hit.text,
      truncated: !!hit.truncated,
      usage: hit.usage || null,
      model: hit.model || primary.model,
      host: hit.host || '',
      apiStyle: hit.apiStyle || primary.apiStyle,
      attempts: 1,
      fellBack: false,
      elapsedMs: 0,
      maxTokens: hit.maxTokens || maxTokens,
      notes: [],
    };
    log.info(`${name} 缓存命中`, { from: hit.from, model: result.model, imgs: images.length });
  } else if (pendingCalls.has(cacheKey)) {
    coalesced = true;
    log.info(`${name} 合并到进行中的同一请求`, { imgs: images.length });
    result = await pendingCalls.get(cacheKey);
  } else {
    // detach 模式下不把 signal 传下去：客户端取消时上游继续跑完，好把结果写进缓存
    const promise = callVision({
      images,
      prompt,
      maxTokens,
      temperature,
      config,
      log,
      semaphore,
      signal: config.cancelMode === 'abort' ? signal : undefined,
    });
    pendingCalls.set(cacheKey, promise);
    try {
      result = await promise;
    } finally {
      pendingCalls.delete(cacheKey);
    }
    cache.set(cacheKey, {
      text: result.text,
      truncated: result.truncated,
      usage: result.usage,
      model: result.model,
      host: result.host,
      apiStyle: result.apiStyle,
      maxTokens: result.maxTokens,
    });
    log.info(`${name} 完成`, {
      model: result.model,
      host: result.host,
      ms: result.elapsedMs,
      in: result.usage && result.usage.in,
      out: result.usage && result.usage.out,
      imgs: images.length,
      bytes: images.reduce((a, b) => a + (b.bytes || 0), 0),
      attempts: result.attempts,
      truncated: result.truncated || undefined,
      fellback: result.fellBack || undefined,
      chars: result.text.length,
    });
  }

  // 正文在最前面，溯源信息放末尾 —— 前缀会污染 OCR 结果
  let text = result.text.trim();
  if (result.truncated) text = TRUNCATED_BANNER(result.maxTokens) + text;
  if (unknownKeys.length) {
    text += `\n\n（提示：参数 ${unknownKeys.join('、')} 不被识别，已忽略；本工具的图片参数是 image_path / image_paths / image_url / image_urls。）`;
  }
  if (config.showMeta) text += `\n\n———\n${buildMeta(images, result, cached, coalesced)}`;

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      text: result.text,
      tool: name,
      model: result.model,
      host: result.host,
      truncated: !!result.truncated,
      cached,
      elapsed_ms: result.elapsedMs,
      usage: result.usage || null,
      images: images.map((i) => ({
        source: i.kind,
        ref: i.kind === 'url' ? i.url : i.file,
        bytes: i.bytes,
        mime: i.mime,
        resolved_via: i.via || 'url',
      })),
      notes: result.notes && result.notes.length ? result.notes : undefined,
    },
  };
}

module.exports = { TOOLS, TOOL_MAP, listTools, runTool, buildPrompt, buildMeta, fmtBytes, fmtAge, GENERIC_PROMPT, OCR_PROMPT, UI_PROMPT, ERROR_PROMPT, COMPARE_PROMPT };

'use strict';

/**
 * 业务错误。按 MCP 规范，这类失败要作为 result.isError = true 返回给模型，
 * 而不是 JSON-RPC error —— 模型看得到文字才能自己换个路径重试。
 * hint 是给模型的“下一步怎么做”，会一起回传。
 */
class VisionError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'VisionError';
    this.hint = opts.hint || '';
    this.code = opts.code || 'vision_error';
    this.status = opts.status;
    this.retryable = !!opts.retryable;
    this.details = opts.details;
  }

  /** 回给模型的完整文本 */
  toToolText() {
    let s = `识图失败：${this.message}`;
    if (this.hint) s += `\n\n下一步：${this.hint}`;
    return s;
  }
}

module.exports = { VisionError };

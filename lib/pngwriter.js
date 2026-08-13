'use strict';

/**
 * 极小的 PNG 生成器（只用内置 zlib，零依赖）。
 * 用途：--ping 自检和测试套件需要一张“真实合法”的图片，
 * 但不想在仓库里塞二进制资源、也不想依赖某台机器上的壁纸路径。
 */

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c;
  }
  return TABLE;
}

function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number]|((x:number,y:number)=>[number,number,number])} color 单色或按坐标取色
 */
function makePng(width, height, color) {
  const pick = typeof color === 'function' ? color : () => color;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const rgb = pick(x, y) || [0, 0, 0];
      const o = y * rowLen + 1 + x * 3;
      raw[o] = rgb[0] & 0xff;
      raw[o + 1] = rgb[1] & 0xff;
      raw[o + 2] = rgb[2] & 0xff;
    }
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 左半红、右半蓝 —— 自检时让模型描述颜色，肉眼就能判断对不对 */
function makeTwoTonePng(size = 96) {
  return makePng(size, size, (x) => (x < size / 2 ? [220, 38, 38] : [37, 99, 235]));
}

module.exports = { makePng, makeTwoTonePng, crc32 };

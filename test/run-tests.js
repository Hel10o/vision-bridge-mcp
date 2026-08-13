#!/usr/bin/env node
'use strict';

/**
 * 测试入口：node test/run-tests.js [--live]
 * 退出码 0 = 全部通过；1 = 有失败。CI 里可以直接用。
 */

const SUITES = ['./unit.test', './protocol.test', './mock-api.test', './live.test'];

(async () => {
  const t0 = Date.now();
  const results = [];
  for (const modPath of SUITES) {
    let s;
    try {
      s = require(modPath);
    } catch (e) {
      process.stdout.write(`\n✗ 加载测试文件失败 ${modPath}: ${e.stack || e.message}\n`);
      process.exit(1);
    }
    results.push(await s.run());
  }

  const total = results.reduce((a, r) => ({ passed: a.passed + r.passed, failed: a.failed + r.failed, skipped: a.skipped + r.skipped }), {
    passed: 0,
    failed: 0,
    skipped: 0,
  });

  process.stdout.write('\n' + '═'.repeat(60) + '\n');
  for (const r of results) {
    const flag = r.failed ? '✗' : '✓';
    process.stdout.write(`${flag} ${r.name}: ${r.passed} 通过, ${r.failed} 失败${r.skipped ? `, ${r.skipped} 跳过` : ''}\n`);
  }
  process.stdout.write('─'.repeat(60) + '\n');
  process.stdout.write(`合计: ${total.passed} 通过, ${total.failed} 失败, ${total.skipped} 跳过（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);

  if (total.failed) {
    process.stdout.write('\n失败明细:\n');
    for (const r of results) {
      for (const f of r.failures) process.stdout.write(`  ✗ [${r.name}] ${f.title}\n      ${String(f.err && f.err.message).split('\n').join('\n      ')}\n`);
    }
  }
  if (total.skipped && !process.argv.includes('--live')) {
    process.stdout.write('\n提示: 加 --live 可以额外跑真实 API 测试（会消耗额度）\n');
  }
  process.exit(total.failed ? 1 : 0);
})();

// node --test：impact-check 改后 diff 对账。纯函数 + 临时库反向 grep。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ic = await import('./lib/impactcheck.mjs');

// 造一个临时目标库：service 定义 formatPrice；pageA 调用它；pageB 不调用。
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'impact-repo-'));
  mkdirSync(join(root, 'utils'), { recursive: true });
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'utils/price.js'), 'export function formatPrice(n){ return n.toFixed(2); }\n');
  writeFileSync(join(root, 'pages/a.js'), 'import { formatPrice } from "../utils/price.js";\nconst x = formatPrice(1);\n');
  writeFileSync(join(root, 'pages/b.js'), 'const y = 1 + 1;\n');
  return root;
}

const SAMPLE_DIFF = `diff --git a/utils/price.js b/utils/price.js
index 111..222 100644
--- a/utils/price.js
+++ b/utils/price.js
@@ -1,1 +1,1 @@
-export function formatPrice(n){ return n.toFixed(2); }
+export function formatPrice(n){ return Number(n).toFixed(2); }
diff --git a/utils/secret.js b/utils/secret.js
index 000..333 100644
--- /dev/null
+++ b/utils/secret.js
@@ -0,0 +1,1 @@
+const helperThing = 42;
`;

test('IC1. extractChanges 抽出改动文件 + 触碰的顶层符号', () => {
  const changes = ic.extractChanges(SAMPLE_DIFF);
  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['utils/price.js', 'utils/secret.js']);
  const price = changes.find((c) => c.path === 'utils/price.js');
  assert.ok(price.symbols.includes('formatPrice'), 'function 定义应被抽为符号');
  const secret = changes.find((c) => c.path === 'utils/secret.js');
  assert.ok(secret.symbols.includes('helperThing'), 'const 定义应被抽为符号');
  assert.ok(price.added >= 1 && price.removed >= 1, '增删行应计数');
});

test('IC2. findCallers 在库里 grep 到调用方，排除改动文件自身', () => {
  const root = makeRepo();
  const callers = ic.findCallers(root, ['formatPrice'], ['utils/price.js']);
  assert.ok(callers.formatPrice, '应找到 formatPrice 的调用方');
  assert.ok(callers.formatPrice.includes('pages/a.js'), 'pages/a.js 调用了它');
  assert.ok(!callers.formatPrice.includes('pages/b.js'), 'pages/b.js 未调用');
  assert.ok(!callers.formatPrice.includes('utils/price.js'), '定义文件自身应被排除');
});

test('IC3. reconcile 命中「越界文件」与「未覆盖调用方」', () => {
  const r = ic.reconcile({
    changedFiles: ['utils/price.js', 'utils/secret.js'],
    callers: { formatPrice: ['pages/a.js'] },
    planText: '本次只改 price.js 修复金额格式',   // 没提到 secret.js → 越界
    impactText: '回归：price.js',                  // 没提到 pages/a.js → 漏测
  });
  assert.deepEqual(r.outOfScope, ['utils/secret.js'], 'secret.js 计划外 → 越界');
  assert.equal(r.uncoveredCallers.length, 1);
  assert.deepEqual(r.uncoveredCallers[0], { sym: 'formatPrice', file: 'pages/a.js' });
});

test('IC4. reconcile 覆盖齐全时越界/漏测均为空', () => {
  const r = ic.reconcile({
    changedFiles: ['utils/price.js'],
    callers: { formatPrice: ['pages/a.js'] },
    planText: '改 price.js',
    impactText: '回归清单：price.js、pages/a.js 都要回归',
  });
  assert.deepEqual(r.outOfScope, []);
  assert.deepEqual(r.uncoveredCallers, []);
});

test('IC5. buildImpactCheck 产出五节 + checklist + 诚实边界，stats 正确', () => {
  const root = makeRepo();
  const { markdown, stats } = ic.buildImpactCheck({
    root,
    diffText: SAMPLE_DIFF,
    planText: '只改 price.js',
    impactText: '回归：price.js',
    bugId: 'BUG-001',
    base: 'HEAD',
  });
  // 五节标题
  assert.match(markdown, /一、实际改动/);
  assert.match(markdown, /二、计划外改动/);
  assert.match(markdown, /三、反向依赖波及/);
  assert.match(markdown, /四、诚实边界/);
  assert.match(markdown, /五、逐条核对结论/);
  // 客观改动列出被改文件
  assert.match(markdown, /utils\/price\.js/);
  // secret.js 越界告警
  assert.match(markdown, /⚠ utils\/secret\.js/);
  // 反向依赖：pages/a.js 未覆盖告警
  assert.match(markdown, /pages\/a\.js/);
  // 启发式边界字样
  assert.match(markdown, /启发式/);
  assert.match(markdown, /不等于.*无影响|不等于「无影响」/);
  // AI 自查 checklist
  assert.match(markdown, /- \[ \]/);
  // 统计
  assert.equal(stats.changedFiles, 2);
  assert.ok(stats.symbols >= 2);
  assert.equal(stats.outOfScope, 1, 'secret.js 越界');
  assert.equal(stats.uncoveredCallers, 1, 'pages/a.js 漏测');
});

test('IC6. 无计划文本时降级：只列客观改动、跳过越界判定', () => {
  const root = makeRepo();
  const { markdown, stats } = ic.buildImpactCheck({ root, diffText: SAMPLE_DIFF, planText: '', impactText: '', bugId: 'X' });
  assert.match(markdown, /未读到 fix-plan\.md \/ impact\.md/);
  // 无计划文本 → 每个改动文件都会被判为「计划外」（这是预期：提醒补计划）
  assert.equal(stats.changedFiles, 2);
});

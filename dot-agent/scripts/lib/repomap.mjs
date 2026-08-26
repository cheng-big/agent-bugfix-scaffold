// repo-map：零依赖扫目标代码库骨架 → Markdown 架构图谱草稿（供 AI 语义标注）。
// 只做确定性静态抽取：目录树 / 入口 / 页面·路由 / 云函数 / 服务工具 / 依赖热点 / 盲区提醒。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.agent', 'dist', 'build', '.next', 'miniprogram_npm', 'coverage', '.vscode', '.idea']);
const CODE = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.vue', '.wxml']);

function walk(dir, root, acc, depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      acc.dirs.push(relative(root, full));
      if (depth < 6) walk(full, root, acc, depth + 1);
    } else if (e.isFile()) {
      acc.files.push(relative(root, full));
    }
  }
}

// 抽 import/require 的被引模块，统计热点（谁被引用最多）
function importHotspots(root, files) {
  const count = new Map();
  const re = /(?:import[^'"]*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))/g;
  for (const f of files) {
    if (!CODE.has(extname(f))) continue;
    let src;
    try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    let m;
    while ((m = re.exec(src))) {
      const mod = m[1] || m[2];
      if (!mod || (!mod.startsWith('.') && !mod.startsWith('/'))) continue; // 只看本地相对引用
      count.set(mod, (count.get(mod) || 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
}

export function buildRepoMap(root) {
  const acc = { dirs: [], files: [] };
  walk(root, root, acc);

  // 小程序页面：读 app.json 的 pages
  const lines = [];
  const pages = [];
  const appJson = join(root, 'app.json');
  const miniAppJson = join(root, 'miniprogram', 'app.json');
  for (const aj of [appJson, miniAppJson]) {
    if (existsSync(aj)) {
      try {
        const j = JSON.parse(readFileSync(aj, 'utf8'));
        for (const p of (j.pages || [])) pages.push(p);
        for (const sub of (j.subpackages || j.subPackages || [])) {
          for (const p of (sub.pages || [])) pages.push(`${sub.root}/${p}`);
        }
      } catch { /* ignore */ }
    }
  }

  // web 路由：找 router 配置文件
  const routerFiles = acc.files.filter((f) => /(^|\/)(router|routes)(\/index)?\.(js|ts|mjs|jsx|tsx)$/.test(f));
  // 云函数：cloudfunctions/* 子目录
  const cloudFns = acc.dirs.filter((d) => /(^|\/)cloudfunctions\/[^/]+$/.test(d)).map((d) => basename(d));
  // 服务/工具：utils|services|api 目录下的文件
  const services = acc.files.filter((f) => /(^|\/)(utils|services|service|api)\//.test(f) && CODE.has(extname(f)));
  // views/pages 目录（web）
  const viewDirs = acc.dirs.filter((d) => /(^|\/)(views|pages|components)$/.test(d));

  lines.push('# 架构图谱（repo-map 骨架 + 待 AI 语义标注）', '');
  lines.push(`> 扫描根：\`${root}\`　目录 ${acc.dirs.length} · 文件 ${acc.files.length}`, '');

  lines.push('## 页面 / 路由');
  if (pages.length) { lines.push('小程序 pages（app.json）：'); for (const p of pages) lines.push(`- ${p}`); }
  if (routerFiles.length) { lines.push('web 路由配置：'); for (const r of routerFiles) lines.push(`- ${r}　<!-- TODO: 展开路由表 -->`); }
  if (viewDirs.length) { lines.push('页面目录：'); for (const v of viewDirs) lines.push(`- ${v}/`); }
  if (!pages.length && !routerFiles.length && !viewDirs.length) lines.push('- （未识别到页面/路由，人工补）');
  lines.push('');

  lines.push('## 云函数 / 后端入口');
  if (cloudFns.length) for (const c of cloudFns) lines.push(`- cloudfunctions/${c}`);
  else lines.push('- （无 cloudfunctions/，若有后端在别处请人工补）');
  lines.push('');

  lines.push('## 服务 / 工具层');
  if (services.length) for (const s of services.slice(0, 40)) lines.push(`- ${s}`);
  else lines.push('- （未识别 utils/services，人工补）');
  lines.push('');

  lines.push('## 依赖热点（被本地引用最多 = 改动风险高）');
  const hot = importHotspots(root, acc.files);
  if (hot.length) for (const [mod, n] of hot) lines.push(`- ${mod}　×${n}`);
  else lines.push('- （未统计到相对引用）');
  lines.push('');

  lines.push('## ⚠ 已知盲区（静态扫描看不到，需后续阶段补）');
  lines.push('- 动态/反射调用（`this[m]()`、eventBus.emit）→ reproduce 用运行时探针补');
  lines.push('- 跨端/云边界（页面→云函数→DB/三方 API）→ reproduce 用云端日志补');
  lines.push('- 配置/环境驱动分支 → reproduce 时确认实际走哪条');
  lines.push('- 数据形状问题（数据长得不对）→ reproduce 抓真实数据样本');
  lines.push('');

  lines.push('## 语义标注（AI 填：每个模块干嘛、数据怎么流）');
  lines.push('<!-- TODO by AI：对照上面清单，逐块写"职责 + 数据流向"，并对每条 bug 涉及页面画出调用链 -->');
  lines.push('');

  return { markdown: lines.join('\n'), stats: { dirs: acc.dirs.length, files: acc.files.length, pages: pages.length, cloudFns: cloudFns.length, services: services.length } };
}

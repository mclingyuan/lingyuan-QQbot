// ============================================================
//  plugins.js —— 插件系统（借鉴 AstrBot 的插件生态）
//
//  ── 目标 ──
//  AstrBot 有 1000+ 插件一键装；我们不需要那个体量，但需要那个**形状**：
//  以后加新功能 = 往 plugins/ 丢一个文件（或一个目录），不用再改 index.js / commands.js。
//
//  ── 约定一：单文件插件（旧格式，继续支持）──
//     module.exports = {
//       name: '示例',
//       cmds: [
//         {
//           re: /^#hi$/i,            // 匹配群消息（已剥 @、压空白）
//           ownerOnly: false,        // true = 只有主人能用
//           whenOff: false,          // true = 关机时也能用（默认不行）
//           help: '#hi --- 示例指令',
//           async handler(ctx, m) { return '你好！'; },   // 返回字符串就回复；返回 null/undefined 不回
//         },
//       ],
//     };
//
//  ── 约定二：目录式插件（🆕 2026-10-22，向 AstrBot 规范对齐）──
//     plugins/astrbot_plugin_xxx/
//       ├ metadata.yaml     ← 和 AstrBot 插件同字段：name / display_name / desc / version / author / repo
//       └ main.js           ← module.exports 和单文件格式完全一样
//     两者都存在才算合法；metadata.yaml 缺字段时用目录名兜底。
//     （注意：AstrBot 的插件是 Python，跑不了也不能跑 —— 这里只是**借用它的规范和安装体验**。）
//
//  ── 护栏 ──
//  · 单文件/单目录加载失败只跳过它，绝不影响机器人启动
//  · 每个指令按群 3 秒冷却（防刷屏），主人免冷却
//  · handler 抛错只打日志，绝不炸消息管线
//  · 🆕 reloadIfChanged()：目录里文件有增删改就自动重载（配合插件市场安装，~20s 内免重启生效）
// ============================================================
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./yaml-mini');

const DIR = path.join(__dirname, 'plugins');
const COOLDOWN_MS = 3000;
const lastFire = new Map();          // key = scope:pluginName → ts

let plugins = [];
let loadedPaths = [];                // 本轮加载用到的模块绝对路径（重载前用来清 require.cache）
let lastSig = '';                    // 插件目录签名（文件清单 + mtime + size）

function scanSignature() {
  // 对 plugins/ 下所有 .js 文件和目录插件文件做轻量签名；任何增删改都会变。
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      out.push(`D:${p}:${st.mtimeMs}`);
      let kids = [];
      try { kids = fs.readdirSync(p).sort(); } catch { /* */ }
      for (const k of kids) walk(path.join(p, k));
    } else {
      out.push(`F:${p}:${st.mtimeMs}:${st.size}`);
    }
  };
  let top = [];
  try { top = fs.readdirSync(DIR).sort(); } catch { return ''; }
  for (const f of top) {
    if (f.endsWith('.js')) walk(path.join(DIR, f));
    else walk(path.join(DIR, f));   // 目录也走（里面只认 main.js/metadata.yaml）
  }
  return out.join('|');
}

// 从目录里读一个目录式插件；失败返回 null（调用方打日志跳过）
function loadDirPlugin(dir, dirName) {
  const mainJs = path.join(dir, 'main.js');
  if (!fs.existsSync(mainJs)) return null;
  // 清掉旧的 require 缓存，保证重载拿到新代码
  const rp = require.resolve(mainJs);
  if (require.cache[rp]) delete require.cache[rp];
  const mod = require(mainJs);
  if (!mod || !Array.isArray(mod.cmds) || !mod.cmds.length) return null;

  // metadata.yaml（可选）—— 字段对齐 AstrBot 插件规范
  let meta = {};
  const yml = path.join(dir, 'metadata.yaml');
  if (fs.existsSync(yml)) {
    try { meta = parseYaml(fs.readFileSync(yml, 'utf8')) || {}; } catch { meta = {}; }
  }
  return {
    file: path.relative(__dirname, mainJs),
    dir: dirName,
    name: String(mod.name || meta.name || meta.display_name || dirName),
    cmds: mod.cmds,
    whenOff: !!mod.whenOff,
    meta: {
      name: meta.name || dirName,
      display_name: meta.display_name || meta.name || dirName,
      desc: meta.desc || meta.description || '',
      version: meta.version || '',
      author: meta.author || '',
      repo: meta.repo || '',
      source: 'dir',
    },
  };
}

function load() {
  plugins = [];
  lastSig = scanSignature();
  let entries = [];
  try { entries = fs.readdirSync(DIR).sort(); } catch { return plugins; }

  for (const f of entries) {
    const full = path.join(DIR, f);
    try {
      if (f.endsWith('.js')) {
        // 旧格式：单文件插件
        const rp = require.resolve(full);
        if (require.cache[rp]) delete require.cache[rp];
        const p = require(full);
        if (p && Array.isArray(p.cmds) && p.cmds.length) {
          plugins.push({ file: f, name: String(p.name || f), cmds: p.cmds, whenOff: !!p.whenOff, meta: { name: f, display_name: String(p.name || f), source: 'file' } });
          loadedPaths.push(rp);
        }
      } else {
        // 新格式：目录式插件（AstrBot 规范对齐）
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (!st.isDirectory()) continue;
        if (f.startsWith('_') || f.startsWith('.')) continue;   // _备份 / 隐藏目录跳过
        const p = loadDirPlugin(full, f);
        if (p) { plugins.push(p); loadedPaths.push(require.resolve(path.join(full, 'main.js'))); }
        else console.warn(`[plugins] 目录 ${f}/ 缺 main.js 或没有可用指令（已跳过）`);
      }
    } catch (e) {
      console.warn(`[plugins] 加载 ${f} 失败（已跳过）：${e.message}`);
    }
  }
  if (plugins.length) {
    console.log(`[plugins] 已加载 ${plugins.length} 个插件：${plugins.map((p) => p.name).join('、')}`);
  }
  return plugins;
}

// 🆕 轮询用：插件目录有变化就重载（插件市场装完 ~20s 内自动生效，不用重启）
//    返回 true = 发生了重载
function reloadIfChanged() {
  const sig = scanSignature();
  if (!lastSig || sig === lastSig) return false;
  console.log('[plugins] 检测到插件目录变化，自动重载…');
  load();
  return true;
}

function cooldownOk(scope, name, isOwner) {
  if (isOwner) return true;
  const key = `${scope}:${name}`;
  const t = lastFire.get(key) || 0;
  if (Date.now() - t < COOLDOWN_MS) return false;
  lastFire.set(key, Date.now());
  return true;
}

// 尝试用插件处理一条消息。
// ctx = { scope, openid, isGroup, d, text, isOwner, powerOn, send(kind, text) }
// 返回：null = 没插件接；{ handled:true } = 已处理（含自己发送的情况）；{ text } = 让调用方代发
async function tryCommand(ctx, log = () => {}) {
  const raw = String(ctx.text || '').trim();
  if (!raw) return null;
  for (const p of plugins) {
    for (const c of p.cmds) {
      if (!c.re || !c.re.test(raw)) continue;
      if (c.ownerOnly && !ctx.isOwner) return null;        // 主人指令被路人触发 → 装没看见（别回复）
      if (!ctx.powerOn && !c.whenOff) return { handled: true, off: true };
      try {
        if (!cooldownOk(ctx.scope, p.name, ctx.isOwner)) return { handled: true, cooldown: true };
        const out = await c.handler(ctx, c.re.exec(raw));
        if (out == null) return { handled: true };
        return { text: String(out) };
      } catch (e) {
        log(`插件 ${p.name} 出错：${e.message}`);
        return { handled: true };
      }
    }
  }
  return null;
}

function listPlugins() {
  return plugins.map((p) => ({
    name: p.name, file: p.file, dir: p.dir || '',
    meta: p.meta || {},
    cmds: p.cmds.map((c) => ({ help: c.help || String(c.re), ownerOnly: !!c.ownerOnly })),
  }));
}

// 🆕 给 /api/x/status 用
function stats() {
  return { list: listPlugins() };
}

function menuLines() {
  const lines = [];
  for (const p of plugins) for (const c of p.cmds) if (c.help && !c.hidden) lines.push(c.help);
  return lines;
}

module.exports = { load, tryCommand, listPlugins, menuLines, stats, reloadIfChanged, DIR };

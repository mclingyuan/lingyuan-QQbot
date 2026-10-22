// ============================================================
//  plugins.js —— 插件系统（借鉴 AstrBot 的插件生态）
//
//  ── 目标 ──
//  AstrBot 有 1000+ 插件一键装；我们不需要那个体量，但需要那个**形状**：
//  以后加新功能 = 往 plugins/ 丢一个文件，不用再改 index.js / commands.js。
//
//  ── 约定（一个插件 = 一个 .js 文件）──
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
//  ── 护栏 ──
//  · 单文件加载失败只跳过它，绝不影响机器人启动
//  · 每个指令按群 3 秒冷却（防刷屏），主人免冷却
//  · handler 抛错只打日志，绝不炸消息管线
// ============================================================
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'plugins');
const COOLDOWN_MS = 3000;
const lastFire = new Map();          // key = scope:pluginName → ts

let plugins = [];

function load() {
  plugins = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort(); } catch { return plugins; }
  for (const f of files) {
    try {
      const p = require(path.join(DIR, f));
      if (p && Array.isArray(p.cmds) && p.cmds.length) {
        plugins.push({ file: f, name: String(p.name || f), cmds: p.cmds, whenOff: !!p.whenOff });
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
    name: p.name, file: p.file,
    cmds: p.cmds.map((c) => ({ help: c.help || String(c.re), ownerOnly: !!c.ownerOnly })),
  }));
}

function menuLines() {
  const lines = [];
  for (const p of plugins) for (const c of p.cmds) if (c.help && !c.hidden) lines.push(c.help);
  return lines;
}

module.exports = { load, tryCommand, listPlugins, menuLines, DIR };

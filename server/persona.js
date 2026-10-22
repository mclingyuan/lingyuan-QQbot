// ============================================================
//  persona.js —— 分群人格切换（借鉴 AstrBot 的多 Persona）
//
//  ── 干什么 ──
//  presets.js 已经能存/切"全局人设快照"（面板点卡片）。
//  本模块补的是**按群生效**：A 群用默认鲸鱼娘，B 群用"毒舌版"，互不影响。
//
//  ── 实现 ──
//  data/persona-group.json = { "群scope": { presetId, name, persona } }
//  generateReply 构建 system 提示词时问一句 persona.override(scope)：
//  有分群人格就用它，没有就用全局（cfg.persona.systemPrompt）——
//  **不建第二套真源**，只是"分群覆盖层"，和 presets 的设计哲学一致。
//
//  切换指令走 plugins.js（#rg），这里只提供存储 + 读取。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'persona-group.json');

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = (o && typeof o === 'object') ? o : {};
  } catch { cache = {}; }
  return cache;
}

function write(obj) {
  if (process.env.XLJ_NO_PERSIST === '1') { cache = obj; return { ok: true, persisted: false }; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = obj;
    return { ok: true, persisted: true };
  } catch (e) { return { ok: false, why: e.message }; }
}

// 该群当前覆盖用的 system 提示词（没有 → ''，调用方回落到全局人设）
function override(scope) {
  const o = read()[scope];
  return o && o.persona ? String(o.persona) : '';
}

function info(scope) {
  const o = read()[scope];
  return o ? { presetId: o.presetId || '', name: o.name || '', chars: String(o.persona || '').length } : null;
}

// 从 presets 里按 id/名称选一个，存成该群覆盖
function setFromPreset(scope, key) {
  let presets;
  try { presets = require('./presets'); } catch { return { ok: false, why: 'presets 模块不可用' }; }
  const items = presets.list();       // summarize 过的 {id,name,...}
  const k = String(key || '').trim();
  if (!k) return { ok: false, why: '要指定预设名' };
  const hit = items.find((p) => p.id === k) || items.find((p) => p.name === k)
    || items.find((p) => p.name && p.name.includes(k));
  if (!hit) {
    const names = items.map((p) => p.name).join('、') || '（还没有任何预设）';
    return { ok: false, why: `找不到预设「${k}」。现有的：${names}` };
  }
  // 取预设的完整内容（personas 原文）。空 persona = "用代码默认" ⇒ 拒绝存空覆盖
  let full = null;
  try {
    const raw = JSON.parse(fs.readFileSync(presets.FILE, 'utf8'));
    full = (raw.items || []).find((it) => it.id === hit.id);
  } catch { /* 读不到就走 null */ }
  const persona = full && full.persona ? String(full.persona) : '';
  if (!persona) return { ok: false, why: `预设「${hit.name}」没有存独立人设（它用的是代码默认），没有可覆盖的内容` };
  const obj = read();
  obj[scope] = { presetId: hit.id, name: hit.name, persona, ts: Date.now() };
  const w = write(obj);
  return w.ok ? { ok: true, name: hit.name } : { ok: false, why: w.why };
}

function clear(scope) {
  const obj = read();
  if (!obj[scope]) return { ok: false, why: '本群没有设置分群人格（用的就是全局）' };
  const gone = obj[scope].name || obj[scope].presetId;
  delete obj[scope];
  const w = write(obj);
  return w.ok ? { ok: true, name: gone } : { ok: false, why: w.why };
}

module.exports = { override, info, setFromPreset, clear, FILE };

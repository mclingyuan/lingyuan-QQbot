// ============================================================
//  kb.js —— 本地知识库（RAG，借鉴 AstrBot 的 Knowledge Base）
//
//  ── 解决什么 ──
//  · 机器人知识截止 2025 年中（README 已知限制）
//  · 反编造闸（knowledgeGate）压力大 —— 没有可靠资料来源，只能硬说"不知道"
//  ⇒ 本模块：群主把"机器人该知道的"写成条目落盘；每条消息先检索，
//    命中就把资料块注入 L2 提示词 —— **人设照常演，事实以资料为准**。
//
//  ── 检索算法（为什么不用真向量）──
//  零依赖铁律 ⇒ 不能装 embedding 库。改用**字符 2-gram 余弦相似度**：
//  中文短文本检索里效果够用（本项目条目量级 < 500），且 0 依赖、毫秒级。
//
//  ── 数据 ──
//  data/kb.json = { items: [{ id, ts, title, text, tags[] }] }
//  安全约束全按 presets.js 的成熟套路：原子写 + .bak 备份 + 上限校验 +
//  XLJ_NO_PERSIST=1 只动内存（测试模式）。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'kb.json');

const MAX_ITEMS = Number(process.env.KB_MAX_ITEMS) || 500;
const MAX_TEXT = 2000;     // 单条正文上限（字）
const MAX_TITLE = 60;
const TOP_K = 3;           // 每次最多注入 3 条
const MIN_SCORE = 0.18;    // 相似度门槛（实测中文短问 0.2 上下是"沾边"，0.1 以下是噪音）

let cache = null;
let cacheRaw = '';

// ---------- 读写（照抄 presets.js 的安全套路）----------
function read() {
  if (process.env.XLJ_NO_PERSIST === '1') return cache || (cache = { items: [] });
  let txt;
  try { txt = fs.readFileSync(FILE, 'utf8'); } catch { return { items: [] }; }
  if (cache && txt === cacheRaw) return cache;
  try {
    const o = JSON.parse(txt);
    const items = Array.isArray(o && o.items) ? o.items : [];
    cache = { items };
    cacheRaw = txt;
    return cache;
  } catch { return { items: [] }; }   // 坏了当空，绝不让机器人起不来
}

function write(items) {
  if (process.env.XLJ_NO_PERSIST === '1') { cache = { items }; cacheRaw = ''; return { ok: true, persisted: false }; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 备份失败不拦 */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = { items }; cacheRaw = fs.readFileSync(FILE, 'utf8');
    return { ok: true, persisted: true };
  } catch (e) { return { ok: false, why: e.message }; }
}

// ---------- 文本 → 字符 2-gram 权重表 ----------
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const m = new Map();
  for (let i = 0; i < t.length; i++) {
    const g = t.slice(i, i + 2);       // 2-gram（末位单字也算，短词不至于丢）
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const [g, v] of b) { nb += v * v; const av = a.get(g); if (av) dot += av * v; }
  return (na && nb) ? dot / Math.sqrt(na * nb) : 0;
}

// ---------- 增删查 ----------
function cleanText(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_TEXT); }
function newId() { return 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function add({ title, text, tags } = {}) {
  const t = cleanText(title).slice(0, MAX_TITLE);
  const body = cleanText(text);
  if (!t || !body) return { ok: false, why: '标题和内容都不能为空' };
  const items = read().items.slice();
  if (items.length >= MAX_ITEMS) return { ok: false, why: `知识库已满（上限 ${MAX_ITEMS} 条），先删旧的（#kb删 id）` };
  // 标题+内容完全重复就不入库
  if (items.some((it) => it.title === t && it.text === body)) return { ok: false, why: '已有完全相同的条目' };
  const it = {
    id: newId(), ts: Date.now(), title: t, text: body,
    tags: (Array.isArray(tags) ? tags : []).map((x) => cleanText(x).slice(0, 20)).filter(Boolean).slice(0, 8),
  };
  items.push(it);
  const w = write(items);
  return w.ok ? { ok: true, item: it, persisted: w.persisted } : { ok: false, why: w.why };
}

function remove(id) {
  const items = read().items.slice();
  const idx = items.findIndex((it) => it.id === String(id || '').trim());
  if (idx < 0) return { ok: false, why: `找不到条目 ${id}` };
  const [gone] = items.splice(idx, 1);
  const w = write(items);
  return w.ok ? { ok: true, item: gone } : { ok: false, why: w.why };
}

function get(id) { return read().items.find((it) => it.id === String(id || '').trim()) || null; }

function list(limit = 20) {
  return read().items.slice(-limit).reverse().map((it) => ({
    id: it.id, title: it.title, chars: it.text.length, tags: it.tags, ts: it.ts,
  }));
}

function stats() { return { count: read().items.length, max: MAX_ITEMS, file: FILE }; }

// ---------- 检索 ----------
function search(q, k = TOP_K, minScore = MIN_SCORE) {
  const query = String(q || '').trim();
  if (!query) return [];
  const qg = grams(query);
  const qWords = query.toLowerCase().replace(/\s+/g, '');
  const scored = [];
  for (const it of read().items) {
    const corpus = `${it.title} ${it.tags.join(' ')} ${it.text.slice(0, 400)}`;   // 只拿前 400 字算相似度（提速）
    let s = cosine(qg, grams(corpus));
    // 标签/标题里的整词命中给强加分（比 2-gram 可靠）
    for (const tag of it.tags) if (tag && qWords.includes(tag.toLowerCase())) s += 0.3;
    if (it.title && qWords.includes(it.title.toLowerCase())) s += 0.3;
    if (s > 0) scored.push({ score: Math.min(1.5, s), item: it });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score >= minScore).slice(0, k);
}

// ---------- 给模型看的资料块 ----------
function promptBlock(q) {
  const hits = search(q);
  if (!hits.length) return '';
  const lines = hits.map((h, i) =>
    `  ${i + 1}.【${h.item.title}】${h.item.text}`);
  return `\n\n【资料库（群主写的可靠资料，事实以此为准）】\n${lines.join('\n')}`;
}

module.exports = { add, remove, get, list, search, promptBlock, stats, FILE, _grams: grams };

// ============================================================
//  contextstore.js —— 上下文持久化 + 自动压缩（借鉴 AstrBot 的
//  Auto Context Compression + 会话记忆持久化）
//
//  ── 解决什么（README 两条已知限制）──
//  ① 「上下文内存态，重启清空，不保留长期记忆」
//     ⇒ 每 60s 把 brain.js 的 contexts Map 原子落盘，启动时灌回去；
//  ② 「被挤掉的旧话题彻底消失，冷场后接不上 3 小时前的话」
//     ⇒ pushContext 挤掉的旧消息先进"待压缩池"，攒够了用**判断模型**
//       （便宜，走 brain.callAI 计费/预算/重试那套）压成 ≤120 字摘要落盘，
//       注入在上下文最前面 —— 旧话题不断片，token 还可控。
//
//  ── 为什么独立模块 ──
//  brain.js 不 import 它的成本模型：这里 lazy require('./brain')，
//  避免 brain ↔ contextstore 循环 require（Node 处理得了，但别赌）。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'context.json');

const SUMMARIZE_AT_CHARS = 900;   // 待压缩池攒到这么多字才花一次模型（省钱）
const SUMMARY_MAX_CHARS = 140;    // 摘要上限
const MAX_SUMMARY_LEN = 2000;     // 摘要字段防膨胀（反复压缩时截旧）
const SAVE_DEBOUNCE_MS = 4000;

let contextsRef = null;           // brain.js 的 contexts Map（gid → arr）
const summaries = new Map();      // gid → { text, ts }
const pending = new Map();        // gid → 待压缩的消息数组
let dirty = false;
let saveTimer = null;
let busy = false;                 // 压缩串行化（一次只发一个模型请求）

// ---------- 落盘 ----------
function loadInto(contexts) {
  contextsRef = contexts;
  if (process.env.XLJ_NO_PERSIST === '1') return;
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    let n = 0;
    for (const [gid, arr] of Object.entries(o.contexts || {})) {
      if (!Array.isArray(arr) || !arr.length) continue;
      contexts.set(gid, arr.filter((m) => m && m.content != null).slice(-60));
      n++;
    }
    for (const [gid, s] of Object.entries(o.summaries || {})) {
      if (s && s.text) summaries.set(gid, s);
    }
    if (n || Object.keys(o.summaries || {}).length) {
      console.log(`[contextstore] 已恢复 ${n} 个群的上下文、${summaries.size} 份话题摘要`);
    }
  } catch { /* 首次启动/文件坏了都当没有 */ }
}

function snapshot() {
  const contexts = {};
  if (contextsRef) for (const [gid, arr] of contextsRef) contexts[gid] = arr;
  const sums = {};
  for (const [gid, s] of summaries) sums[gid] = s;
  return { contexts, summaries: sums };
}

function flush() {
  if (!contextsRef || process.env.XLJ_NO_PERSIST === '1') return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf8');
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (e) { console.warn(`[contextstore] 落盘失败：${e.message}`); }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
}

// ---------- 压缩 ----------
// brain.pushContext 挤掉旧消息时调用（droppedArr = 被挤掉的那几条）
function noteDropped(gid, droppedArr) {
  if (!Array.isArray(droppedArr) || !droppedArr.length) return;
  if (process.env.XLJ_NO_PERSIST !== '1') scheduleSave();
  const pool = pending.get(gid) || [];
  for (const m of droppedArr) {
    if (m && m.content != null && String(m.content).trim()) {
      pool.push(`${m.name || '?'}:${String(m.content).slice(0, 80)}`);
    }
  }
  pending.set(gid, pool);
  const chars = pool.reduce((a, s) => a + s.length, 0);
  if (chars >= SUMMARIZE_AT_CHARS) summarize(gid).catch(() => {});
}

async function summarize(gid) {
  if (busy) { scheduleSave(); return; }
  const pool = pending.get(gid) || [];
  if (pool.length < 4) return;
  busy = true;
  try {
    const brain = require('./brain');            // lazy：避开循环 require
    const lines = pool.slice(0, 40).join('\n');
    pending.set(gid, pool.slice(40));
    const sys = '你是群聊记录摘要员。把对话压缩成一段不超过120字的要点摘要，'
      + '保留人名、事实、约定和未完结的话题，丢掉寒暄和语气词。只输出摘要本身。';
    const prev = summaries.get(gid);
    const user = (prev && prev.text ? `已有的更早摘要：${prev.text}\n\n` : '')
      + `新的对话片段：\n${lines}`;
    const r = await brain.callAI(sys, user, null, 200, false, null, null, '', 'context-compress');
    const text = String(r && (typeof r === 'string' ? r : r.text) || '').trim();
    if (text) {
      const merged = prev && prev.text
        ? (text.length > SUMMARY_MAX_CHARS ? text : `${text}；${prev.text}`.slice(0, MAX_SUMMARY_LEN))
        : text.slice(0, MAX_SUMMARY_LEN);
      summaries.set(gid, { text: merged, ts: Date.now() });
      console.log(`[contextstore] ${gid.slice(0, 10)}… 话题摘要已更新（${merged.length} 字）`);
      scheduleSave();
    }
  } catch (e) {
    // 压缩失败绝不影响主流程：片段留在池里，下次再试
    console.warn(`[contextstore] 压缩失败（下轮再试）：${e.message}`);
  } finally { busy = false; }
}

// 给模型看的"更早的话题"文本（没有就返回 ''，调用方按空串处理）
function summaryFor(gid) {
  const s = summaries.get(gid);
  return s && s.text ? s.text : '';
}

function stats() {
  return {
    groups: contextsRef ? contextsRef.size : 0,
    summaries: summaries.size,
    pendingGroups: [...pending.entries()].filter(([, p]) => p.length).length,
    file: FILE,
  };
}

// 定时兜底 + 退出前保存
setInterval(() => { if (dirty) flush(); }, 60000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flush(); } catch { /* */ } });
}

module.exports = { loadInto, noteDropped, summaryFor, summarize, flush, stats };

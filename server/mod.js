// ============================================================
//  mod.js —— 会话限流 + 敏感词前置（借鉴 AstrBot 的频控/内容过滤）
//
//  ── 限流 ──
//  brain.js 的 atRateGate 管"同一个人连发"（防单人刷）；
//  这里补**整群维度**：1 分钟内机器人回超过 N 条就静默冷却 1 分钟 ——
//  群里炸锅（红包/吵架/刷屏）时机器人不跟着刷，既省钱又不像机器人蹦迪。
//
//  ── 敏感词 ──
//  data/banned-words.json = ["词1","词2"]（不存在的文件 = 不过滤）
//  在发送**之前**替换命中词为 ＊（比发出去再撤回强 —— 官方撤不了）。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const RATE_FILE = path.join(DATA_DIR, 'mod.json');
const WORDS_FILE = path.join(DATA_DIR, 'banned-words.json');

const DEFAULT_PER_MIN = Number(process.env.MOD_REPLIES_PER_MIN) || 15;
const WINDOW_MS = 60000;

// ---------- 限流 ----------
let replies = new Map();       // scope → 时间戳数组
let cooldownUntil = new Map(); // scope → ts
let overrides = {};            // scope → 自定义每分钟上限（WebUI 可改）

try { overrides = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8')) || {}; } catch { overrides = {}; }
function persistOverrides() {
  try {
    const tmp = RATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(overrides), 'utf8');
    fs.renameSync(tmp, RATE_FILE);
  } catch { /* */ }
}

function limitOf(scope) {
  const v = Number(overrides[scope]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PER_MIN;
}

function setLimit(scope, n) {
  overrides[scope] = Math.max(1, Math.min(120, Number(n) | 0));
  persistOverrides();
  return limitOf(scope);
}

// 回复前调用：false = 本群该闭嘴了
function allow(scope, now = Date.now()) {
  const cd = cooldownUntil.get(scope) || 0;
  if (now < cd) return false;
  const arr = (replies.get(scope) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  replies.set(scope, arr);
  const lim = limitOf(scope);
  if (arr.length > lim) {
    cooldownUntil.set(scope, now + WINDOW_MS);
    replies.set(scope, []);
    console.log(`[mod] ${scope.slice(0, 10)}… 1 分钟内已回 ${lim} 条 → 冷却 1 分钟`);
    return false;
  }
  return true;
}

// 刚才那条是否被限流拦了（给 index.js 记日志用）
function blocked(scope, now = Date.now()) { return now < (cooldownUntil.get(scope) || 0); }

// ---------- 敏感词 ----------
let words = [];
try { words = (JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8')) || []).map(String).filter(Boolean); } catch { words = []; }
let re = null;
function rebuild() {
  if (!words.length) { re = null; return; }
  try { re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'); }
  catch { re = null; }
}
rebuild();

function filter(text) {
  if (!re || !text) return { text, hit: 0 };
  let hit = 0;
  const out = String(text).replace(re, () => { hit++; return '＊'; });
  return { text: out, hit };
}

function setWords(list) {
  words = (Array.isArray(list) ? list : []).map(String).map((w) => w.trim()).filter(Boolean).slice(0, 500);
  try {
    const tmp = WORDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(words), 'utf8');
    fs.renameSync(tmp, WORDS_FILE);
  } catch { /* 写不进也先用内存这份 */ }
  rebuild();
  return words.length;
}

function getWords() { return words.slice(); }

function stats() {
  return { perMinDefault: DEFAULT_PER_MIN, overrides: Object.keys(overrides).length, bannedWords: words.length };
}

module.exports = { allow, blocked, filter, setLimit, setWords, getWords, stats, WORDS_FILE };

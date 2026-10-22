// ============================================================
//  scheduler.js —— 定时任务 / 主动消息（借鉴 AstrBot 的定时播报）
//
//  ── 干什么 ──
//  data/schedule.json = { jobs: [{ id, scope, groupOpenid, time:"HH:MM", text, enabled, lastDay }] }
//  每 20 秒检查一次：到点且今天没发过 → 发出去。
//
//  🔴 官方平台事实（必读）：
//  QQ 官方机器人**主动发消息**受平台限制（每月额度、需在后台开通相应场景），
//  而且和"被动回复 5 分钟窗口"是两回事。所以：
//  · 发送失败不重试（失败多半是额度/权限，重试只会更糟）
//  · 任务上限 10 条/群（防刷）
//  · 仅在开机时发（power.isOn）—— 关机就是什么都不做，铁律
// ============================================================
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const FILE = path.join(DATA_DIR, 'schedule.json');
const MAX_PER_GROUP = 10;

let jobs = [];
let started = false;

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    jobs = Array.isArray(o && o.jobs) ? o.jobs : [];
  } catch { jobs = []; }
  return jobs;
}

function persist() {
  if (process.env.XLJ_NO_PERSIST === '1') return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* */ } }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ jobs }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.warn(`[scheduler] 落盘失败：${e.message}`); }
}

function newId() { return 'j' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

function parseTime(s) {
  const m = /^(\d{1,2})[：:点时](\d{1,2})?分?$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] == null ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function listFor(scope) { return jobs.filter((j) => j.scope === scope && j.enabled !== false); }

function add(scope, groupOpenid, timeStr, text) {
  const time = parseTime(timeStr);
  const body = String(text || '').trim().slice(0, 150);
  if (!time) return { ok: false, why: '时间格式是 `#定时 09:30 内容`（24 小时制）' };
  if (!body) return { ok: false, why: '要说的话不能为空' };
  if (!groupOpenid) return { ok: false, why: '拿不到本群的 openid（私聊里不能加定时任务）' };
  if (jobs.filter((j) => j.scope === scope).length >= MAX_PER_GROUP) {
    return { ok: false, why: `本群任务已到上限（${MAX_PER_GROUP} 条），先 #定时删` };
  }
  const job = { id: newId(), scope, groupOpenid, time, text: body, enabled: true, lastDay: '' };
  jobs.push(job);
  persist();
  return { ok: true, job };
}

function remove(id, scope) {
  const idx = jobs.findIndex((j) => j.id === String(id || '').trim() && (!scope || j.scope === scope));
  if (idx < 0) return { ok: false, why: `找不到任务 ${id}` };
  const [gone] = jobs.splice(idx, 1);
  persist();
  return { ok: true, job: gone };
}

// 主循环
function tick(sendGroupMessage, powerIsOn) {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.toISOString().slice(0, 10);
  for (const j of jobs) {
    if (j.enabled === false || j.time !== hhmm || j.lastDay === day) continue;
    j.lastDay = day;
    persist();
    if (!powerIsOn(j.scope)) {
      console.log(`[scheduler] ${j.time} 任务跳过（${j.scope.slice(0, 10)}… 已关机）`);
      continue;
    }
    sendGroupMessage(j.groupOpenid, String(j.text).slice(0, 400))
      .then((ok) => console.log(`[scheduler] ${j.time} 播报${ok ? ' ✓ 已发' : ' ✗ 发送失败（多为官方主动消息额度/权限）'}`))
      .catch((e) => console.warn(`[scheduler] 播报异常：${e.message}`));
  }
}

function start(sendGroupMessage, powerIsOn) {
  if (started) return;
  started = true;
  load();
  if (jobs.length) console.log(`[scheduler] 已加载 ${jobs.length} 个定时任务`);
  setInterval(() => {
    try { tick(sendGroupMessage, powerIsOn); } catch (e) { console.warn(`[scheduler] tick 异常：${e.message}`); }
  }, 20000);
}

function stats() {
  return {
    total: jobs.length,
    enabled: jobs.filter((j) => j.enabled !== false).length,
    jobs: jobs.slice(0, 30).map((j) => ({ id: j.id, scope: j.scope, time: j.time, text: j.text, enabled: j.enabled !== false })),
  };
}

module.exports = { start, add, remove, listFor, stats, load, FILE, _parseTime: parseTime };

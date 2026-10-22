// ============================================================
//  pluginmarket.js —— 插件市场（规范向 AstrBot 对齐，零依赖）
//
//  ── 它是什么、不是什么 ──
//  · 是：一套"市场卡片式"的插件安装/卸载/更新体验 —— 索引 JSON（字段名与
//    AstrBot 插件市场一致：name / display_name / desc / short_desc / version /
//    author / repo），git clone 安装到 server/plugins/，装完自动热重载。
//  · 不是：AstrBot 官方市场的镜像。AstrBot 市场里的插件是 Python 程序，
//    依赖 AstrBot 核心（Star / Context / AstrMessageEvent），在 Node 进程里
//    根本跑不了 —— 所以这里装的是**按本插件规范写的 JS 插件**（目录式，
//    metadata.yaml + main.js）。索引源的 URL 可以在 WebUI 里自己加。
//
//  ── 数据文件 ──
//  · data/market-sources.json   自定义市场索引 URL 列表（WebUI 可增删）
//  · data/plugin-backups/       卸载/覆盖时把旧插件搬到这里，不真删
//
//  ── 护栏 ──
//  · 索引拉取超时 8s，失败回退内置样例索引，绝不卡 WebUI
//  · 安装只接受：合法 git 仓库（clone --depth 1）或本地路径（测试用）
//  · 装进来的目录必须有 metadata.yaml + main.js，缺一就拒装
//  · 覆盖/卸载一律先备份，绝不直接删代码
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { parseYaml } = require('./yaml-mini');

const SERVER_DIR = __dirname;
const PLUGINS_DIR = path.join(SERVER_DIR, 'plugins');
const DATA_DIR = path.join(SERVER_DIR, '..', 'data');
const SOURCES_FILE = path.join(DATA_DIR, 'market-sources.json');
const BACKUP_DIR = path.join(DATA_DIR, 'plugin-backups');
const SAMPLE_INDEX = path.join(SERVER_DIR, 'docs', 'plugin-market.json');

const FETCH_TIMEOUT_MS = 8000;

// ---------- 索引源 ----------
function getSources() {
  try { return JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')) || []; }
  catch { return []; }
}

function setSources(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const urls = [...new Set(list.map(String).filter(Boolean))];
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(urls, null, 2));
  return urls;
}

function fetchJson(url) {
  // Node 22 内置 fetch + 超时（用 AbortController）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ac.signal })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .finally(() => clearTimeout(timer));
}

// ---------- 市场列表 ----------
// 返回 { ok, plugins: [...], sources: [...], fallback: bool, why? }
async function listMarket() {
  const sources = getSources();
  let all = [];
  let fallback = false;
  let why = '';

  // 远程源（自定义 URL），逐个拉，失败忽略
  const results = await Promise.allSettled(sources.map((u) => fetchJson(u)));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : (Array.isArray(r.value.plugins) ? r.value.plugins : []);
      all = all.concat(arr);
    }
  }
  // 没拉到任何远程源 → 用内置样例索引（保证 WebUI 永远有东西可看）
  if (!all.length) {
    try {
      const sample = JSON.parse(fs.readFileSync(SAMPLE_INDEX, 'utf8'));
      all = Array.isArray(sample.plugins) ? sample.plugins : [];
      fallback = true;
      why = sources.length ? '远程索引拉取失败，已回退内置样例' : '未配置远程索引，展示内置样例';
    } catch (e) {
      why = `样例索引读取失败：${e.message}`;
    }
  }
  return { ok: true, plugins: all, sources, fallback, why };
}

// ---------- 安装 ----------
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 400)));
      else resolve(stdout);
    });
  });
}

function backupPluginDir(dir) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let dest = path.join(BACKUP_DIR, `${path.basename(dir)}-${ts}`);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(BACKUP_DIR, `${path.basename(dir)}-${ts}-${n++}`);  // 同秒多次备份也不撞名
  fs.renameSync(dir, dest);
  return dest;
}

// 校验拿到的目录是一个合法目录式插件；返回 metadata 对象或抛错
function validatePluginDir(dir) {
  const yml = path.join(dir, 'metadata.yaml');
  const main = path.join(dir, 'main.js');
  if (!fs.existsSync(main)) throw new Error('目录里缺 main.js（不按规范的插件装不了）');
  if (!fs.existsSync(yml)) throw new Error('目录里缺 metadata.yaml（不按规范的插件装不了）');
  const meta = parseYaml(fs.readFileSync(yml, 'utf8')) || {};
  if (!meta.name) throw new Error('metadata.yaml 缺 name 字段');
  return meta;
}

// repo: https://github.com/xxx/yyy（git clone）或本地绝对路径 / file://（测试用）
// 返回 { ok, name, dir, updated }
async function install(repo) {
  repo = String(repo || '').trim();
  if (!repo) throw new Error('repo 不能为空');

  const isLocal = repo.startsWith('file://') || path.isAbsolute(repo);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-plugin-'));
  try {
    let src;
    if (isLocal) {
      src = repo.startsWith('file://') ? repo.replace(/^file:\/\//, '') : repo;
      if (!fs.statSync(src).isDirectory()) throw new Error('本地路径不是目录');
      // 拷一份，走和 git 相同的校验/落地流程
      src = fs.cpSync ? (() => { const d = path.join(tmpRoot, 'repo'); fs.cpSync(src, d, { recursive: true }); return d; })() : src;
    } else {
      if (!/^https?:\/\//.test(repo)) throw new Error('repo 必须是 http(s) 的 git 地址或本地路径');
      src = path.join(tmpRoot, 'repo');
      await run('git', ['clone', '--depth', '1', '--quiet', repo, src]);
    }

    // 仓库根就是插件？还是根下有一层插件目录？两种都认（单插件仓库优先）
    let rootValid = false;
    try { validatePluginDir(src); rootValid = true; } catch { /* 根不是插件，看子目录 */ }
    const pluginDirs = [];
    if (rootValid) {
      pluginDirs.push(src);
    } else {
      for (const f of fs.readdirSync(src).sort()) {
        const d = path.join(src, f);
        try {
          if (fs.statSync(d).isDirectory()) { validatePluginDir(d); pluginDirs.push(d); }
        } catch { /* 子目录不是合法插件就跳过 */ }
      }
      if (!pluginDirs.length) throw new Error('仓库里没找到任何合法插件（需要 metadata.yaml + main.js）');
    }

    const installed = [];
    for (const dir of pluginDirs) {
      const meta = validatePluginDir(dir);
      const name = String(meta.name);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`插件名不合法：${name}`);
      const dest = path.join(PLUGINS_DIR, name);
      let updated = false;
      if (fs.existsSync(dest)) { backupPluginDir(dest); updated = true; }
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      fs.cpSync(dir, dest, { recursive: true });
      installed.push({ name, dir: dest, updated });
    }

    // 立即热重载本进程；机器人主进程靠 plugins.reloadIfChanged() 在 ~20s 内跟上
    try { require('./plugins').load(); } catch { /* */ }
    return { ok: true, installed };
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ---------- 卸载 ----------
// name: 插件目录名（= metadata.yaml 的 name）
function uninstall(name) {
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('插件名不合法');
  const dir = path.join(PLUGINS_DIR, name);
  if (dir === PLUGINS_DIR || !fs.existsSync(dir)) throw new Error(`没找到插件：${name}`);
  if (!fs.statSync(dir).isDirectory()) throw new Error('该名字不是目录式插件（内置单文件插件请在服务器上手动删文件）');
  const backup = backupPluginDir(dir);
  try { require('./plugins').load(); } catch { /* */ }
  return { ok: true, backup };
}

function stats() {
  let sources = [];
  try { sources = getSources(); } catch { /* */ }
  let installed = [];
  try {
    installed = fs.readdirSync(PLUGINS_DIR)
      .filter((f) => fs.statSync(path.join(PLUGINS_DIR, f)).isDirectory() && !f.startsWith('_') && !f.startsWith('.'));
  } catch { /* */ }
  return { sources: sources.length, installed: installed.length };
}

module.exports = { listMarket, install, uninstall, getSources, setSources, stats };

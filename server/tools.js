// ============================================================
//  tools.js —— 工具闸（借鉴 AstrBot 的 MCP / Function Calling）
//
//  ── 为什么不是真 function calling ──
//  项目的省钱铁律：「能不用模型解决的就不用模型」。真 function calling
//  要把工具表塞进每次 L2 请求（前缀缓存全毁）+ 解析 tool_calls + 二次调用。
//  ⇒ 这里做**确定性工具闸**：正则认出"纯算式 / 问天气 / 要搜索"，
//    直接干活 —— 计算器和天气 0 次模型，搜索把结果注入提示词（人设照常）。
//
//  ── 三个工具 ──
//  ① calc    ：纯算式 → Node 安全求值（0 成本，永不答错）
//  ② weather ：wttr.in（免 key）→ 代码直答
//  ③ search  ：search.js 搜结果 → 返回注入块（L2 仍由模型用自己口吻说）
// ============================================================
const search = require('./search');

// ---------- ① 计算器 ----------
// 白名单字符校验后才允许 eval —— 这是安全红线（绝不 eval 任意输入）
const CALC_RE = /^[0-9a-fA-FxX+\-*/×÷()（）^.,，。%%？?=\s]+$/;

function normalizeCalc(s) {
  return String(s || '')
    .replace(/[×xX]/g, '*').replace(/[÷]/g, '/')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[，。]/g, (c) => (c === '，' ? ',' : '.'))
    .replace(/[,，。=?？\s]/g, '')
    .replace(/\^/g, '**')
    .replace(/(\d)%/g, '($1/100)');
}

function calc(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 60) return null;
  // 常见中文包装词："1+2*3等于多少" → "1+2*3"（剥完必须是纯算式才允许求值）
  s = s.replace(/(等于多少|等于几|是多少|得多少|等于|帮我算|算一下|计算一下|一下|请你|请)/g, '')
    .replace(/[？?=\s，。]/g, '');
  if (!s || !CALC_RE.test(s)) return null;
  if (!/\d/.test(s) || !/[+\-*/^]/.test(s)) return null;      // 得像一道算式
  if (s.length > 80) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${s})`)();
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const out = Math.abs(v - Math.round(v)) < 1e-10
      ? String(Math.round(v))
      : String(Number(v.toFixed(6)));
    return `${String(raw).replace(/[？?=]+$/, '').trim()} = ${out}`;
  } catch { return null; }
}

// ---------- ② 天气（wttr.in，免 key）----------
const CITY_HINT = /([\u4e00-\u9fa5]{2,8})的?(?:天气|气温|温度|下雨|下雪)/;

function parseCity(text) {
  const m = CITY_HINT.exec(String(text || ''));
  if (!m) return '';
  const raw = m[1].replace(/^(?:今天|明天|后天|现在|本地|我们)/, '');
  return raw || '';
}

async function weather(city) {
  const c = String(city || '').trim();
  if (!c) return null;
  try {
    const mod = require('./search');
    const { status, text } = await mod._httpsGet(
      `https://wttr.in/${encodeURIComponent(c)}?format=j1&lang=zh`, {});
    if (status !== 200) return null;
    const j = JSON.parse(text);
    const cur = j.current_condition && j.current_condition[0];
    if (!cur) return null;
    const area = j.nearest_area && j.nearest_area[0];
    const name = area && area.areaName ? area.areaName[0].value : c;
    const today = j.weather && j.weather[0];
    const t = `${name}现在${cur.temp_C}°C，体感${cur.FeelsLikeC}°C，${cur.lang_zh ? cur.lang_zh[0].value : (cur.weatherDesc ? cur.weatherDesc[0].value : '')}，`
      + (today ? `今天${today.mintempC}~${today.maxtempC}°C，降水概率${(today.hourly && today.hourly[8] ? today.hourly[8].chanceofrain : '?')}%。` : '');
    return t.slice(0, 150);
  } catch { return null; }
}

// ---------- ③ 搜索 ----------
const SEARCH_RE = /(?:搜(?:一)?下|搜索|百度一下|谷歌一下|帮我查|查一下|帮我搜)(?:下|搜索)?\s*[：:，,]?\s*(.{2,60})/;

function parseSearch(text) {
  const m = SEARCH_RE.exec(String(text || ''));
  return m ? m[1].replace(/^(?:关于|这个|那个|一下|的)/, '').replace(/[？?。！!]+$/, '').trim() : '';
}

async function searchBlock(q) {
  const query = String(q || '').trim();
  if (!query) return '';
  const results = await search.search(query, console.log);
  return search.asPromptBlock(results, query);
}

// ---------- 工具闸主入口 ----------
// 返回值三种：
//   { kind:'direct', text }  —— 代码已算好，直接发（0 成本）
//   { kind:'inject', note }  —— 资料已备好，拼进 extraNote 让 L2 用人设说
//   null                     —— 不是工具类问题，走原流程
async function gate(askText) {
  const t = String(askText || '').trim();
  if (!t || t.length > 120) return null;

  // ① 纯算式（必须先于其它判断 —— 算式里可能带"?"）
  const c = calc(t);
  if (c) return { kind: 'direct', text: c };

  // ② 天气
  if (/(天气|气温|温度|下不下雨|会下雨)/.test(t) && !/(预报靠谱|天气好烦|因为.*天气)/.test(t)) {
    const city = parseCity(t);
    if (city) {
      const w = await weather(city);
      if (w) return { kind: 'direct', text: w };
    }
  }

  // ③ 明确要搜索
  const q = parseSearch(t);
  if (q) {
    const note = await searchBlock(q);
    if (note) return { kind: 'inject', note };
  }
  return null;
}

module.exports = { gate, calc, weather, searchBlock, _normalizeCalc: normalizeCalc };

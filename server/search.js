// ============================================================
//  search.js —— 联网搜索（零依赖，借鉴 AstrBot 的 Web Search）
//
//  ── 干什么 ──
//  给机器人补"知识截止"短板：群里问到新东西时，抓搜索引擎结果，
//  拼成参考资料块注入 L2 提示词（人设照常，事实以搜索为准）。
//
//  ── 来源 ──
//  ① DuckDuckGo Lite（html.duckduckgo.com/lite）—— 无需 key、无验证码、HTML 极简好解析
//  ② 必应（cn.bing.com/search）—— 兜底
//
//  ── 铁律 ──
//  · 零依赖：node 内置 https + zlib（gzip）
//  · 绝不抛错：失败返回 []，调用方自行降级（宁可不注入，不能卡管线）
//  · 超时硬闸 8s：搜索慢就放弃，别堵整条消息链
// ============================================================
const https = require('https');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 8000;
const MAX_RESULTS = 5;

// ---------- 底层：https GET（自动解 gzip/deflate）----------
function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        ...(opts.headers || {}),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        return httpsGet(next, opts).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        } catch { /* 解不开就按原文用 */ }
        resolve({ status: res.statusCode, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ---------- 解析工具 ----------
function decodeEnt(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x?([0-9a-fA-F]+);/g, (m, h) => {
      try { return String.fromCodePoint(parseInt(h.startsWith('x') ? h.slice(1) : h, h.startsWith('x') ? 16 : 10)); } catch { return m; }
    });
}
function stripTags(s) { return decodeEnt(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }

// ---------- 来源 ①：DuckDuckGo Lite ----------
// 结果页结构很稳：每条结果是一个 <a rel="nofollow" class="result-link" href="...">标题</a>
// 紧跟一行 <td class="result-snippet">摘要</td>
async function searchDuck(q) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=cn-zh';
  const { status, text } = await httpsGet(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).catch(() => ({ status: 0, text: '' }));
  if (status !== 200 || !text) return [];
  const out = [];
  // 宽松抓取：<a ... class="result-link" href="跳转链接">标题</a>（链接是 //duckduckgo.com/l/?uddg=编码后的真实地址）
  const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_RESULTS * 2) {
    let href = decodeEnt(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(href)) continue;
    // 摘要：在标题后面的 html 里找 snippet
    const tail = text.slice(m.index, m.index + 2000);
    const sn = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/.exec(tail)
      || /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/.exec(text.slice(m.index, m.index + 4000));
    out.push({ title, url: href, snippet: sn ? stripTags(sn[1]).slice(0, 200) : '' });
  }
  // 按 url 去重
  const seen = new Set();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))).slice(0, MAX_RESULTS);
}

// ---------- 来源 ②：必应（兜底）----------
async function searchBing(q) {
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=' + MAX_RESULTS;
  const { status, text } = await httpsGet(url).catch(() => ({ status: 0, text: '' }));
  if (status !== 200 || !text) return [];
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo"|$)/g;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_RESULTS) {
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(m[1])) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]);
    out.push({ title, url: decodeEnt(m[1]), snippet: p ? stripTags(p[1]).slice(0, 200) : '' });
  }
  return out;
}

// ---------- 对外主入口 ----------
async function search(q, log = () => {}) {
  const query = String(q || '').trim().slice(0, 80);
  if (!query) return [];
  let results = [];
  try { results = await searchDuck(query); } catch (e) { log(`DDG 失败：${e.message}`); }
  if (!results.length) {
    try { results = await searchBing(query); } catch (e) { log(`必应失败：${e.message}`); }
  }
  log(results.length ? `搜索到 ${results.length} 条结果` : '搜索无结果');
  return results;
}

// 拼成"给模型看的"参考块（放进 user 提示词，别动 system —— 保前缀缓存）
function asPromptBlock(results, q) {
  if (!Array.isArray(results) || !results.length) return '';
  const lines = results.map((r, i) =>
    `  ${i + 1}. ${r.title}${r.snippet ? ` —— ${r.snippet}` : ''}（${r.url}）`);
  return `\n\n【联网搜索：刚刚搜「${q}」的结果】\n`
    + lines.join('\n')
    + `\n回答时以这些结果为事实依据；搜不到的信息就说不知道，不许编。`;
}

module.exports = { search, asPromptBlock, _httpsGet: httpsGet, _stripTags: stripTags };

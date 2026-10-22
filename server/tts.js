// ============================================================
//  tts.js —— 文字转语音（借鉴 AstrBot 的 TTS 供应商列表）
//
//  ── 两条链路（都零依赖）──
//  ① OpenAI 兼容 /audio/speech（优先）：.env 配 TTS_BASE_URL / TTS_API_KEY / TTS_MODEL
//     （SiliconFlow、302.AI、OpenAI 官方等都支持，音色多、稳）
//  ② Edge TTS（免费兜底）：手写 WebSocket + Sec-MS-GEC DRM 签名
//     （算法公开且稳定：SHA256(5分钟取整的 ticks + TrustedClientToken)）
//
//  ── 发送 ──
//  生成 MP3 → qqmedia.uploadMedia(file_type=3 语音) → sendGroupMedia
//  （qqmedia.js 注释明说 3=语音，发图发视频同一条链路，直接复用）
//
//  ── 铁律 ──
//  · 任何失败返回 null，调用方降级发文字 —— 语音失败绝不吞掉回复
//  · XLJ_NO_PERSIST=1 测试模式不写盘
// ============================================================
const https = require('https');
const crypto = require('crypto');

const OPENAI_TIMEOUT_MS = 30000;
const EDGE_TIMEOUT_MS = 12000;

// Edge TTS 常量（公开算法，来自微软语音服务的官方签名方式）
const EDGE_WSS_HOST = 'speech.platform.bing.com';
const EDGE_TRUSTED_TOKEN = '6A5AA1E434F94CA98C7D25380C6C8BF5';
const EDGE_CHROMIUM_VER = '130.0.2849.68';
const DEFAULT_VOICE = process.env.TTS_VOICE || 'zh-CN-XiaoyiNeural';   // 年轻女声，适合鲸鱼娘
const EDGE_PITCH = process.env.TTS_PITCH || '+10Hz';                    // 稍微拔高一点更像少女
const EDGE_RATE = process.env.TTS_RATE || '+5%';

let edgeBrokenUntil = 0;      // Edge 连挂后冷却 10 分钟，别每次都等超时
const EDGE_COOLDOWN_MS = 600000;

// ---------- ① OpenAI 兼容 TTS ----------
function openaiTTS(text) {
  const base = (process.env.TTS_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.TTS_API_KEY || '';
  const model = process.env.TTS_MODEL || '';
  if (!base || !key || !model) return Promise.resolve(null);
  const body = JSON.stringify({ model, input: String(text).slice(0, 800), voice: process.env.TTS_SPEAKER || 'alloy', response_format: 'mp3' });
  const u = new URL(base + '/audio/speech');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: OPENAI_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 1000 ? buf : null);   // 太小说明是报错 JSON
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

// ---------- ② Edge TTS（免费）----------
function edgeSecMsGec() {
  // ticks = 自 1601-01-01 起 100ns 单位，向下取整到 5 分钟（DRM 防重放）
  const ticks = Math.floor((Date.now() / 1000 + 11644473600) / 300) * 300 * 1e7;
  const sha = crypto.createHash('sha256').update(`${Math.round(ticks)}${EDGE_TRUSTED_TOKEN}`).digest('hex');
  return sha.toUpperCase();
}

function edgeTTS(text) {
  return new Promise((resolve) => {
    if (Date.now() < edgeBrokenUntil) return resolve(null);
    const gec = edgeSecMsGec();
    const path = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_TOKEN}`
      + `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM_VER}&ConnectionId=${crypto.randomUUID()}`;
    let ws;
    try { ws = new WebSocket(`wss://${EDGE_WSS_HOST}${path}`); }
    catch { edgeBrokenUntil = Date.now() + EDGE_COOLDOWN_MS; return resolve(null); }

    const chunks = [];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* */ }
      resolve(v);
    };
    const timer = setTimeout(() => {
      edgeBrokenUntil = Date.now() + EDGE_COOLDOWN_MS;
      finish(null);
    }, EDGE_TIMEOUT_MS);

    ws.onopen = () => {
      const id = crypto.randomUUID().replace(/-/g, '');
      ws.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${DEFAULT_VOICE}'><prosody pitch='${EDGE_PITCH}' rate='${EDGE_RATE}'>`
        + String(text).slice(0, 600).replace(/[<>&]/g, ' ').replace(/\n+/g, '。')
        + `</prosody></voice></speak>`;
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    ws.onmessage = (ev) => {
      const handle = (data) => {
        const s = String(Buffer.isBuffer(data) ? data.toString('utf8') : data);
        const idx = s.indexOf('Path:audio\r\n');
        if (idx >= 0) {
          const head = Buffer.from(s.slice(0, idx + 12), 'utf8');
          const bin = Buffer.isBuffer(data) ? data.subarray(head.length) : null;
          if (bin && bin.length) chunks.push(bin);
        } else if (s.includes('Path:turn.end')) {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          finish(buf.length > 1000 ? buf : null);
        }
      };
      handle(ev.data);
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(Buffer.concat(chunks).length > 1000 ? Buffer.concat(chunks) : null); };
  });
}

// ---------- 对外 ----------
async function synth(text) {
  const t = String(text || '').replace(/https?:\/\/\S+/g, '链接').replace(/[*`_~|#>]/g, '').trim();
  if (!t) return null;
  const a = await openaiTTS(t);
  if (a) return { buf: a, ext: 'mp3' };
  const b = await edgeTTS(t);
  if (b) return { buf: b, ext: 'mp3' };
  return null;   // 调用方降级发文字
}

module.exports = { synth, _edgeSecMsGec: edgeSecMsGec };

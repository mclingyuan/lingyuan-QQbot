// ============================================================
//  stt.js —— 语音转文字（借鉴 AstrBot 的 STT 供应商：Whisper 等）
//
//  ── 现实约束（先说清楚，别白等）──
//  QQ 官方机器人 API（本项目平台）**默认不把群语音推给机器人** ——
//  群聊里机器人只收到文本/图片/附件类事件，音频附件只有在私聊（C2C）
//  且开通对应权限时才可能出现。所以本模块是**尽力而为**：
//    · 有音频附件（.mp3/.m4a/.wav/.aac/.amr）→ 转 OpenAI 兼容 STT 接口
//    · 没配 STT 接口 / 没有音频事件 → 静默跳过（0 开销 0 日志噪音）
//
//  ── 配置（.env）──
//  STT_BASE_URL  例如 https://api.siliconflow.cn/v1  （提供 Whisper/免费 STT 的都行）
//  STT_API_KEY
//  STT_MODEL     例如 FunAudioLLM/SenseVoiceSmall（SiliconFlow 免费款）
//
//  ── 接线方式（和 vision.js 同一个套路）──
//  转写结果写 msg.__voice = "文字"，brain.extractText() 读它拼进消息文本 ——
//  语音从此变成"他说了一句话"，L0/L1/L2 全链路自动看得见，零侵入。
//
//  🔴 SILK 格式说明：QQ 语音原生是 silk 格式，Whisper 不认。收到的如果是
//     .silk/.slk 会明确打日志提示（转不了的格式要先用 silk-decoder 转 wav，
//     属于外部工具，零依赖铁律下不内置）。
// ============================================================
const https = require('https');
const crypto = require('crypto');

const TIMEOUT_MS = 30000;
const AUDIO_EXT_RE = /\.(mp3|m4a|wav|aac|ogg|flac|amr)(\?|$)/i;
const UNSUPPORTED_RE = /\.(silk|slk)(\?|$)/i;

let warnedNoConfig = false;

function configured() {
  return !!(process.env.STT_BASE_URL && process.env.STT_API_KEY);
}

// 从消息里找音频附件（尽力而为：附件里 url 可下载且扩展名像音频）
function findAudio(msg) {
  if (!msg || !Array.isArray(msg.attachments)) return null;
  for (const a of msg.attachments) {
    const url = String(a && a.url || '');
    if (!url) continue;
    if (UNSUPPORTED_RE.test(url)) {
      console.log('  ├ 🎙 收到 silk 格式语音（Whisper 不认），跳过（需外部 silk 解码器）');
      return null;
    }
    const ct = String(a.content_type || '').toLowerCase();
    if (ct.includes('audio') || ct === 'file' || AUDIO_EXT_RE.test(url)) {
      if (ct === 'file' && !AUDIO_EXT_RE.test(url)) continue;   // 普通文件别误伤
      return { url: url.startsWith('//') ? 'https:' + url : url, name: String(a.filename || 'audio') };
    }
  }
  return null;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          res.resume();
          return get(new URL(res.headers.location, u).href, redirects + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`))));
      }).on('error', reject);
    };
    get(url, 0);
  });
}

// 手拼 multipart/form-data（零依赖版）
function multipart(field, filename, buf, mime) {
  const boundary = '----xlj' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, buf, tail]) };
}

function transcribe(buf, filename) {
  const base = (process.env.STT_BASE_URL || '').replace(/\/+$/, '');
  const { boundary, body } = multipart('file', filename, buf, 'audio/mpeg');
  const fields = [['model', process.env.STT_MODEL || 'whisper-1']];
  const fieldBuf = Buffer.from(fields.map(([k, v]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join(''), 'utf8');
  const full = Buffer.concat([fieldBuf, body]);
  const u = new URL(base + '/audio/transcriptions');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STT_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': full.length,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const text = String(o && o.text || '').trim();
          resolve(text || null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(full);
  });
}

// 主入口：尽力转写。成功写 msg.__voice 并返回 true；任何失败返回 false（不影响原流程）
async function handle(msg) {
  if (!msg) return false;
  if (!configured()) {
    if (!warnedNoConfig) { console.log('  ├ 🎙 检测到音频附件，但未配置 STT（STT_BASE_URL/KEY/MODEL），跳过'); warnedNoConfig = true; }
    return false;
  }
  const a = findAudio(msg);
  if (!a) return false;
  try {
    const buf = await download(a.url);
    if (!buf || buf.length < 800) return false;
    const text = await transcribe(buf, a.name);
    if (!text) { console.log('  ├ 🎙 语音转写失败/为空，按没有语音处理'); return false; }
    msg.__voice = text.slice(0, 300);
    console.log(`  ├ 🎙 语音转写成功（${msg.__voice.length} 字）：${msg.__voice.slice(0, 30)}…`);
    return true;
  } catch (e) {
    console.warn(`  ├ 🎙 语音处理出错（忽略）：${e.message}`);
    return false;
  }
}

module.exports = { handle, findAudio, configured };

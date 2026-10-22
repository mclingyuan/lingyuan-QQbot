// ============================================================
//  plugins/voice-cmd.js —— 语音能力指令
//    #yy       开/关 本群"语音回复模式"（开着时机器人的文字回复同时发一份语音）
//    #sy 文本  立刻把文本读成语音发出来
// ============================================================
const fs = require('fs');
const path = require('path');
const tts = require('../tts');

const FILE = path.join(__dirname, '..', 'data', 'voice-mode.json');

let cache = null;
function readMode() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
function writeMode(obj) {
  if (process.env.XLJ_NO_PERSIST === '1') { cache = obj; return; }
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, FILE);
    cache = obj;
  } catch { /* */ }
}
function voiceOn(scope) { return !!readMode()[scope]; }
function toggleVoice(scope) {
  const o = readMode();
  o[scope] = !o[scope];
  writeMode(o);
  return o[scope];
}

module.exports = {
  name: '语音',
  voiceOn,
  cmds: [
    {
      re: /^#yy$/i, help: '#yy --- 开关语音回复模式', ownerOnly: true, whenOff: false,
      async handler(ctx) {
        if (!tts.configurable()) {
          return '语音引擎还没就绪（Edge TTS 连不上且没配 TTS_BASE_URL），稍后再试试吧';
        }
        const on = toggleVoice(ctx.scope);
        return on ? '语音回复模式：开（我说话会带一份语音啦～）' : '语音回复模式：关（省点流量）';
      },
    },
    {
      re: /^#sy\s+(.+)$/is, help: '#sy 文本 --- 把文本读出来', ownerOnly: true, whenOff: false,
      async handler(ctx, m) {
        const r = await tts.synth(m[1]);
        if (!r) return null;   // 不回文字，免得尴尬（引擎挂了就沉默）
        await ctx.speak(r);    // 由 index.js 注入的发送函数发语音
        return null;
      },
    },
  ],
};

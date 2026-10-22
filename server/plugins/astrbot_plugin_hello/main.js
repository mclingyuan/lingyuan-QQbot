// ============================================================
//  plugins/astrbot_plugin_hello/main.js —— 目录式插件示例
//
//  目录结构（向 AstrBot 插件规范对齐）：
//    astrbot_plugin_hello/
//      ├ metadata.yaml   ← 名称/版本/作者/仓库（市场展示用）
//      └ main.js         ← 本文件：module.exports 格式与单文件插件完全一样
//
//  想禁用就把目录改名（如 _astrbot_plugin_hello）或直接在 WebUI 里卸载。
// ============================================================
module.exports = {
  name: '你好',
  cmds: [
    {
      re: /^#hello$/i,
      help: '#hello --- 目录式插件示例（AstrBot 规范对齐）',
      ownerOnly: false,
      whenOff: true,              // 关机时也能用
      async handler(ctx, m) {
        return '✅ 目录式插件在线！metadata.yaml + main.js 都识别到了。';
      },
    },
  ],
};

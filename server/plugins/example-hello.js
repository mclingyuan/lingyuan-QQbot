// ============================================================
//  plugins/example-hello.js —— 插件模板示例
//
//  照这个文件的样子写新插件，丢进 plugins/ 目录，重启即生效。
//  想禁用就删掉或改名为 .js.off（不以 .js 结尾就不会被加载）。
// ============================================================
module.exports = {
  name: '示例',
  cmds: [
    {
      // 匹配 "#hi"（可带尾随空白）
      re: /^#hi$/i,
      help: '#hi --- 插件示例（删掉本文件即下线）',
      ownerOnly: false,           // true = 只有主人触发
      whenOff: true,              // true = 关机时也能用（默认 false）
      async handler(ctx) {
        // ctx = { scope, openid, isGroup, d, text, isOwner, powerOn, send }
        return '插件系统在线！（这条回复来自 plugins/example-hello.js）';
      },
    },
  ],
};

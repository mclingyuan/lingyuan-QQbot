// ============================================================
//  plugins/rg-cmd.js —— 分群人格切换（主人）
//    #rg        看本群当前用的人格 + 可选预设列表
//    #rg 名字   切到某个预设（按名称模糊匹配）
//    #rg 重置   回到全局人格（面板里配的那套）
// ============================================================
const persona = require('../persona');
const presets = require('../presets');

module.exports = {
  name: '人格切换',
  cmds: [
    {
      re: /^#rg(?:\s+(.*))?$/i, help: '#rg 预设名 --- 切换本群人格（主人）', ownerOnly: true,
      async handler(ctx, m) {
        const arg = String(m[1] || '').trim();
        if (/^重置$|^恢复$|^默认$/.test(arg)) {
          const r = persona.clear(ctx.scope);
          return r.ok ? `已恢复全局人格（刚才用的是「${r.name}」）` : r.why;
        }
        if (!arg) {
          const cur = persona.info(ctx.scope);
          const names = presets.list().map((p) => p.name).filter(Boolean);
          const lines = [];
          lines.push(cur ? `本群当前：「${cur.name}」（${cur.chars} 字）` : '本群当前：全局人格（没有分群覆盖）');
          if (names.length) lines.push(`可切换：${names.join('、')}`);
          lines.push('用法：`#rg 名字` 切换 / `#rg 重置` 恢复全局');
          return lines.join('\n');
        }
        const r = persona.setFromPreset(ctx.scope, arg);
        return r.ok ? `本群人格已切换为「${r.name}」～` : r.why;
      },
    },
  ],
};

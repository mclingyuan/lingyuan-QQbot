// ============================================================
//  plugins/kb-cmd.js —— 知识库指令（主人管理，群友可查）
//    #kb 关键词      检索测试（谁都能用，看看库里有什么）
//    #kb+ 标题|内容  添加条目（主人）
//    #kb删 id        删除条目（主人）
//    #kb列表         最近条目（主人）
// ============================================================
const kb = require('../kb');

module.exports = {
  name: '知识库',
  cmds: [
    {
      re: /^#kb[\s+＋]?(.*)$/is, help: '#kb 关键词 --- 查资料库', hidden: false,
      async handler(ctx, m) {
        const arg = String(m[1] || '').trim();
        // #kb+ 标题|内容（主人添加）
        if (/^[+＋]/.test(arg)) {
          if (!ctx.isOwner) return '只有主人能往资料库里写东西哦（括号小声）';
          const body = arg.slice(1).trim();
          const sep = body.indexOf('|') >= 0 ? '|' : (body.indexOf('｜') >= 0 ? '｜' : '');
          if (sep < 0) return '格式：`#kb+ 标题|内容`，中间用竖线隔开';
          const title = body.slice(0, body.indexOf(sep)).trim();
          const text = body.slice(body.indexOf(sep) + 1).trim();
          const r = kb.add({ title, text });
          return r.ok ? `记住了：${r.item.title}（id ${r.item.id}）` : `没存上：${r.why}`;
        }
        if (!arg) {
          const s = kb.stats();
          return s.count
            ? `资料库里现在有 ${s.count} 条（上限 ${s.max}）。查具体内容就「#kb 关键词」`
            : '资料库还是空的（括号诚实）。主人可以用「#kb+ 标题|内容」教我东西';
        }
        const hits = kb.search(arg, 3, 0);
        if (!hits.length) return `「${arg}」在资料库里没找到`;
        return hits.map((h) => `【${h.item.title}】${h.item.text.slice(0, 120)}${h.item.text.length > 120 ? '…' : ''}（id ${h.item.id}）`).join('\n');
      },
    },
    {
      re: /^#kb删\s*(\S+)$/i, ownerOnly: true, help: '', hidden: true,
      async handler(ctx, m) {
        const r = kb.remove(m[1]);
        return r.ok ? `删掉了：${r.item.title}` : r.why;
      },
    },
    {
      re: /^#kb列表$/i, ownerOnly: true, help: '', hidden: true,
      async handler() {
        const items = kb.list(15);
        if (!items.length) return '资料库是空的';
        return '最近 15 条：\n' + items.map((it) => `${it.id} ${it.title}（${it.chars}字）`).join('\n');
      },
    },
  ],
};

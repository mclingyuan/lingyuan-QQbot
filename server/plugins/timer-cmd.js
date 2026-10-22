// ============================================================
//  plugins/timer-cmd.js —— 定时任务指令（主人，发给 scheduler.js 执行）
//    #定时                看本群的任务
//    #定时 HH:MM 文本     加一个每日定时播报
//    #定时删 id           删任务
// ============================================================
const scheduler = require('../scheduler');

module.exports = {
  name: '定时任务',
  cmds: [
    {
      re: /^#定时删\s*(\S+)$/i, ownerOnly: true, help: '', hidden: true,
      async handler(ctx, m) {
        const r = scheduler.remove(m[1], ctx.scope);
        return r.ok ? `删掉了任务 ${m[1]}` : r.why;
      },
    },
    {
      re: /^#定时(?:\s+(\S+)\s+(.+))?$/i, help: '#定时 时:分 内容 --- 每日定时播报（主人）', ownerOnly: true,
      async handler(ctx, m) {
        if (!m[1]) {
          const jobs = scheduler.listFor(ctx.scope);
          if (!jobs.length) {
            return '本群还没有定时任务。用法：`#定时 09:00 早安，新的一天也要加油呀～`'
              + '\n（⚠️ 官方机器人主动消息有每月额度，任务别加太多）';
          }
          return '本群定时任务：\n' + jobs.map((j) => `${j.id} ${j.time} ${j.text.slice(0, 30)}`).join('\n')
            + '\n删除：`#定时删 id`';
        }
        const r = scheduler.add(ctx.scope, ctx.openid, m[1], m[2]);
        return r.ok ? `记下了：每天 ${r.job.time} 说「${r.job.text.slice(0, 30)}」（id ${r.job.id}）` : r.why;
      },
    },
  ],
};

# 扩展功能包使用说明（借鉴 AstrBot 功能，2026-10-22）

> 全部零依赖（只用 Node 22 内置），每块独立降级：坏了只跳过那块，绝不影响主聊天管线。
> 修改过的原文件：`index.js`、`brain.js`、`config.js`、`tools/logweb.js`（改前已备份到仓库外）。

## 新增指令一览（已写进 #cd 菜单）

| 指令 | 功能 | 权限 |
|---|---|---|
| `#kb 关键词` | 查资料库 | 所有人 |
| `#kb+ 标题\|内容` | 教机器人一条知识 | 主人 |
| `#kb删 id` / `#kb列表` | 删/看条目 | 主人 |
| `#rg` / `#rg 预设名` / `#rg 重置` | 本群人格切换（分群生效） | 主人 |
| `#定时` / `#定时 09:30 内容` / `#定时删 id` | 每日定时播报 | 主人 |
| `#yy` | 开关本群语音回复模式（文字发出后跟一份语音） | 主人 |
| `#sy 文本` | 立刻把文本读成语音 | 主人 |
| `#hi` | 插件示例（plugins/example-hello.js，可删） | 所有人 |

## 各功能说明

1. **知识库 RAG（kb.js）**：`data/kb.json` 存条目；字符 2-gram 余弦检索，命中的资料在
   模型判"不知道"时自动注入提示词（事实以资料为准，人设照常）。
2. **上下文持久化 + 自动压缩（contextstore.js）**：重启不丢群聊上下文；被挤掉的旧消息
   攒到 ~900 字自动用判断模型压成 ≤120 字摘要注入（"更早的话题摘要"），旧话题不断片。
3. **分群人格（persona.js）**：`#rg` 按 presets 里的预设按群切换，`#rg 重置` 回全局。
4. **语音转文字（stt.js）**：`.env` 配 `STT_BASE_URL / STT_API_KEY / STT_MODEL`
   （OpenAI 兼容 /audio/transcriptions，SiliconFlow 的 SenseVoice 免费）。
   ⚠️ QQ 官方群聊默认不推语音事件 —— 有语音附件时才会转写，没配就静默跳过。
5. **文字转语音（tts.js）**：优先 OpenAI 兼容 `TTS_BASE_URL/KEY/MODEL`；
   没配就走**免费 Edge TTS**（手写 WebSocket + DRM 签名，音色 zh-CN-XiaoyiNeural，
   `TTS_VOICE` 可换）。语音失败自动只发文字。
6. **工具闸（tools.js）**：`1+2*3等于多少` 算式直答（0 成本）；`XX的天气` 走 wttr.in 直答；
   `搜一下 XX` 用 DuckDuckGo（必应兜底）搜完把结果给 L2 用人设说。
7. **联网搜索（search.js）**：DDG Lite + 必应，超时 8s，失败返回空、绝不卡管线。
9. **会话隔离/记忆**：上下文按群落盘（`data/context.json`），重启恢复，见第 2 条。
10. **插件系统（plugins.js）**：往 `server/plugins/` 丢一个 `.js` 即上线
    （模板见 example-hello.js）；每群 3 秒冷却、主人指令自动保护、单文件坏了不影响别的。
10b. **🆕 插件市场（pluginmarket.js + yaml-mini.js，规范向 AstrBot 对齐）**：
    - 目录式插件 = `server/plugins/astrbot_plugin_xxx/`（`metadata.yaml` + `main.js`，
      metadata 字段与 AstrBot 插件一致：name/display_name/desc/version/author/repo，
      示例见 astrbot_plugin_hello）。旧单文件 `.js` 插件继续兼容，一个字不用改。
    - WebUI `/x` 页新增「🧩 插件市场」卡片：看本地插件（含版本/来源）、git 仓库地址一键安装、
      卸载（旧版自动备份到 `data/plugin-backups/`）、全部重载、自定义市场索引源（JSON 地址，
      字段与 AstrBot 插件市场对齐，样例见 `server/docs/plugin-market.json`）。
    - 安装 = `git clone --depth 1`，要求仓库里有合法的 `metadata.yaml + main.js`，缺一拒装；
      装完由 `index.js` 每 20s 的 `plugins.reloadIfChanged()` 自动热重载，**免重启生效**。
    - ⚠️ AstrBot 官方市场的插件是 Python 程序（依赖 AstrBot 核心），跑不了也不能跑 ——
      这里只对齐它的**规范和安装体验**；市场索引填你自己的 JS 插件仓库。
    - 测试：`cd server && node test-market.js`（11 项，含真实 git clone 安装/更新/卸载/拒装）。
11. **WebUI 扩展页**：面板同端口 `/x?p=密码` —— 8 个模块状态、群回复限流设置、
    敏感词增删、定时任务列表。
13. **定时任务（scheduler.js）**：`data/schedule.json`，每 20s 检查，每天一次，
    只在开机时发。⚠️ 官方机器人主动消息有每月额度，失败不重试，任务别加太多。
14. **模型降级链**：你的 brain.js **本来就有**（`modelChain` + `.env` 的
    `AI_FALLBACK_MODELS=deepseek-v4-pro` 即可开启），本次未改动。
15. **群级限流 + 敏感词前置（mod.js）**：每群 1 分钟回复上限（默认 15，`/x` 页可按群改，
    `.env` 的 `MOD_REPLIES_PER_MIN` 改默认值）；`data/banned-words.json` 里的词在
    发送前替换成＊（发出去就撤不回了，所以必须前置）。

## 部署

```bash
# 服务器上备份
cp -r server server.bak-$(date +%m%d)
# 覆盖 server/ 目录后
node --check server/index.js && systemctl restart 你的服务名
```

无需装任何依赖；新增数据文件（kb.json / context.json / schedule.json 等）首次用到时自动创建。
🆕 插件市场的"一键安装"用系统 `git`（服务器一般都自带；没有的话 `apt install -y git`）。

## 验证记录

- 全部文件 `node --check` 通过
- 新模块冒烟测试通过（kb 检索 / calc 求值与注入攻击拦截 / 限流 / 定时 / DRM 签名 / 插件加载）
- 项目自带回归测试：**改前 1036 通过 / 7 失败 → 改后 1037 通过 / 6 失败（零回归）**
  （剩余 6 个失败是仓库不含私有 `data/emotion-lexicon.json` 等文件所致，与本次无关）
- 🆕 2026-10-22 插件市场：`test-market.js` 11/11 通过；`test-brain.js` 仍为 1037/6（零回归）

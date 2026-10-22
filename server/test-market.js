// 冒烟测试：插件目录式加载 / yaml / 市场 / 安装 / 卸载 / 热重载
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = __dirname; // server/
process.chdir(path.join(BASE, '..'));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.log(`  ✗ ${name}: ${e.message}`); });
}

(async () => {
  console.log('== yaml-mini ==');
  const { parseYaml } = require('./yaml-mini');
  await t('解析 metadata.yaml 子集', () => {
    const y = parseYaml(fs.readFileSync(path.join(BASE, 'plugins/astrbot_plugin_hello/metadata.yaml'), 'utf8'));
    assert.strictEqual(y.name, 'astrbot_plugin_hello');
    assert.strictEqual(y.version, '1.0.0');
    assert.strictEqual(y.author, 'lingyuan');
    assert.ok(String(y.desc).includes('目录式插件示范'));
    assert.deepStrictEqual(y.tags, ['示例', '插件市场']);
  });
  await t('注释/空行/数字/布尔', () => {
    const y = parseYaml('# 注释\nkey: value # 行内注释\nn: 42\nflag: true\nempty:\n');
    assert.strictEqual(y.key, 'value');
    assert.strictEqual(y.n, 42);
    assert.strictEqual(y.flag, true);
    assert.strictEqual(y.empty, '');
  });

  console.log('== plugins 加载 ==');
  const plugins = require('./plugins');
  const market = require('./pluginmarket');
  await t('目录式插件被识别（含 meta）', () => {
    const list = plugins.load();
    const hello = list.find((p) => p.dir === 'astrbot_plugin_hello');
    assert.ok(hello, 'astrbot_plugin_hello 没加载上');
    assert.strictEqual(hello.meta.version, '1.0.0');
    assert.strictEqual(hello.meta.source, 'dir');
  });
  await t('单文件插件继续兼容', () => {
    const list = plugins.listPlugins();
    assert.ok(list.some((p) => p.meta.source === 'file'), '单文件插件没了');
  });
  await t('reloadIfChanged 无变化不重载', () => {
    assert.strictEqual(plugins.reloadIfChanged(), false);
  });

  console.log('== 市场 ==');
  await t('listMarket 回退样例索引', async () => {
    const mk = await market.listMarket();
    assert.ok(mk.fallback, '应回退样例');
    assert.ok(mk.plugins.length >= 2);
    assert.strictEqual(mk.plugins[0].name, 'astrbot_plugin_hello');
  });
  await t('索引源增删', () => {
    market.setSources(['https://example.com/a.json']);
    assert.deepStrictEqual(market.getSources(), ['https://example.com/a.json']);
    market.setSources([]);
    assert.deepStrictEqual(market.getSources(), []);
  });

  // 准备一个"远程仓库"（本地 git 仓库模拟）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkrepo-'));
  const repo = path.join(tmp, 'astrbot_plugin_fake');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'metadata.yaml'), 'name: astrbot_plugin_fake\ndisplay_name: 伪装插件\nversion: 0.2.0\nauthor: t\nrepo: x\n');
  fs.writeFileSync(path.join(repo, 'main.js'), "module.exports={name:'伪装',cmds:[{re:/^#fake$/,help:'#fake',handler:()=>1}]};\n");
  const { execFileSync } = require('child_process');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

  await t('git clone 安装 + 热重载生效', async () => {
    const r = await market.install(repo);
    assert.ok(r.installed.some((i) => i.name === 'astrbot_plugin_fake'));
    const list = plugins.listPlugins();
    const fake = list.find((p) => p.dir === 'astrbot_plugin_fake');
    assert.ok(fake, '装完没加载');
    assert.strictEqual(fake.meta.version, '0.2.0');
  });
  await t('重复安装 = 更新（旧版备份）', async () => {
    const r = await market.install(repo);
    assert.ok(r.installed[0].updated, '应标记 updated');
  });
  await t('卸载进备份目录', () => {
    const r = market.uninstall('astrbot_plugin_fake');
    assert.ok(fs.existsSync(r.backup), '备份不存在');
    assert.ok(!plugins.listPlugins().some((p) => p.dir === 'astrbot_plugin_fake'), '卸了还在');
  });
  await t('拒装不合规目录', async () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'badrepo-'));
    fs.writeFileSync(path.join(bad, 'main.js'), 'module.exports={};');
    await market.install(bad).then(() => { throw new Error('竟然装上了'); }, (e) => {
      assert.ok(/metadata.yaml|main.js|合法插件/.test(e.message), '错误信息不对：' + e.message);
    });
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

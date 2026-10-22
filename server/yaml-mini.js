// ============================================================
//  yaml-mini.js —— 极小 YAML 子集解析器（零依赖）
//
//  只为解析插件 metadata.yaml 服务（和 AstrBot 插件同字段的子集）：
//    name: astrbot_plugin_hello
//    display_name: 你好插件
//    desc: |
//      多行描述也可以
//    version: 1.0.0
//    author: 某人
//    repo: https://github.com/xxx/yyy
//    tags:
//      - a
//      - b
//
//  支持：标量（字符串/数字/布尔）、单行内联注释、| 与 > 块标量、两层内的列表。
//  不支持：锚点引用、多文档、复杂嵌套 —— 插件元数据用不到，故意不做。
//  解析失败抛异常（调用方自行兜底），绝不影响机器人主流程。
// ============================================================

function parseScalar(s) {
  const t = String(s).trim();
  if (t === '' || t === '~' || t === 'null') return '';
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2)) return t.slice(1, -1);
  if ((t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1);
  return t;
}

// 去行内注释（不在引号里的 #）
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYaml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const root = {};
  let i = 0;

  // 块标量（| 或 >）：吃掉比当前键缩进更深的行
  function readBlockScalar(indent) {
    const buf = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '') { buf.push(''); i++; continue; }
      const ind = raw.match(/^ */)[0].length;
      if (ind <= indent) break;
      buf.push(raw.slice(indent));
      i++;
    }
    // 去尾部空行
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    return buf.join('\n');
  }

  while (i < lines.length) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim() || line.trim().startsWith('---')) { i++; continue; }

    const m = line.match(/^(\s*)([\w.-]+)\s*:(.*)$/);
    if (!m) { i++; continue; }
    const indent = m[1].length;
    const key = m[2];
    let val = m[3].trim();

    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      i++;                        // 先跳过键行，再收比它缩进更深的块体
      root[key] = readBlockScalar(indent);
      continue;
    }
    if (val === '') {
      // 可能是列表：下一行是 "- xxx"
      const items = [];
      let j = i + 1;
      let listIndent = -1;
      while (j < lines.length) {
        const l2 = stripComment(lines[j]);
        const m2 = l2.match(/^(\s*)-(.*)$/);
        if (!m2) { if (l2.trim() === '') { j++; continue; } break; }
        const ind2 = m2[1].length;
        if (listIndent === -1) listIndent = ind2;
        if (ind2 !== listIndent) break;
        items.push(parseScalar(m2[2]));
        j++;
      }
      if (items.length) { root[key] = items; i = j; continue; }
      root[key] = '';
      i++;
      continue;
    }
    root[key] = parseScalar(val);
    i++;
  }
  return root;
}

module.exports = { parseYaml };

// 消费者模式隐式依赖规则（consumer-pattern.v1）
//
// 切口：DataSemAgent 的 HookPoint 消费者模式——
//   - 生产者：`emit(HookPoint.X, ...)`（app/flow.py、app/node/agent.py、app/memory/hook.py）
//   - 消费者：`@hook(HookPoint.X)`（app/eval/collector.py、app/tool/*）
// 装饰器注册是运行时字符串绑定，import 图看不到——典型隐式依赖。
//
// 能力：
//   1. 非变更模式：全量发现 HookPoint 的生产/消费边（hook-producer / hook-consumer）
//   2. 变更模式（--worktree/--staged + change-surface.v1 注入）：
//      更细粒度的冲击量分析——
//      a. 变更了 HookPoint 成员（registry.py 的类属性）→ 该成员的消费者/生产者全受冲击
//      b. 变更了含 emit(HookPoint.X) 的方法（hunk 容器）→ 该点的消费者受冲击
//      输出每条边的冲击来源（impact=member-changed / emit-container-changed）+
//      控制台汇总（变更成员 → N 消费者 / M 生产者，符号级方法清单）
//
// 变更面是补充事实：脚本主线（text 阶段文件选择）不受变更面影响。
// text 阶段显式取 allFiles（全量候选）——消费者可能在未变更文件中，
// 变更模式默认 files 只含变更文件；非变更模式 allFiles 未注入，退回 files。
//
// 引擎路径边界统一为仓库相对路径（record._file 与 change.file 同形态，
// 绝对路径会随 checkout 位置漂移，校准 2026-08-07）。
//
// 用法：
//   openarch rules discover --rule examples/implicit-deps/consumer-pattern.mjs
//   openarch rules discover --worktree --rule examples/implicit-deps/consumer-pattern.mjs

const HOOK_POINT_RE = /HookPoint\.([A-Z_]+)/;

/** 非变更模式：只做全量发现（无变更面是常态而非失败）。 */
const discoveryEdges = (records) => {
  const edges = [];
  for (const record of records) {
    if (record.kind === "consumer") {
      edges.push({
        from: record._file,
        to: "app/hook/registry.py",
        via: `@hook(HookPoint.${record.point}) in ${record.fn}`,
        type: "hook-consumer",
      });
    } else if (record.kind === "producer") {
      edges.push({
        from: record._file,
        to: "app/hook/registry.py",
        via: `emit(HookPoint.${record.point}) in ${record.fn}`,
        type: "hook-producer",
      });
    }
  }
  return edges;
};

/** 变更模式：从 changedSymbols 收集受冲击的 HookPoint 成员（契约变更）。 */
const impactedPointsFor = (surface) => {
  const impactedPoints = new Set();
  for (const symbol of surface.value.changedSymbols) {
    const m = symbol.anchor.match(HOOK_POINT_RE);
    if (m) impactedPoints.add(m[1]);
    if (symbol.file.endsWith("hook/registry.py")) impactedPoints.add("__REGISTRY__");
  }
  return impactedPoints;
};

/** 变更模式：从变更 hunk 的容器（方法）收集变更的 emit 调用点。 */
const changedContainersFor = (surface) => {
  const changedContainers = new Set();
  for (const change of surface.value.changes) {
    for (const hunk of change.hunks) {
      if (hunk.container) changedContainers.add(`${change.file}#${hunk.container.name}`);
    }
  }
  return changedContainers;
};

/** 变更模式：构建带 impact 标记的边，同时按 HookPoint 成员聚合生产/消费记录。 */
const changeEdges = (records, impactedPoints, changedContainers) => {
  const edges = [];
  const consumersByPoint = new Map();
  const producersByPoint = new Map();
  for (const record of records) {
    if (record.kind === "consumer") {
      const list = consumersByPoint.get(record.point) ?? [];
      list.push(record);
      consumersByPoint.set(record.point, list);
      const impact = impactedPoints.has(record.point)
        ? "impact=member-changed"
        : changedContainers.has(`${record._file}#${record.fn}`)
          ? "impact=consumer-container-changed"
          : "impact=none";
      edges.push({
        from: record._file,
        to: "app/hook/registry.py",
        via: `@hook(HookPoint.${record.point}) in ${record.fn} (${impact})`,
        type: "hook-consumer",
      });
    } else if (record.kind === "producer") {
      const list = producersByPoint.get(record.point) ?? [];
      list.push(record);
      producersByPoint.set(record.point, list);
      const impact = impactedPoints.has(record.point)
        ? "impact=member-changed"
        : changedContainers.has(`${record._file}#${record.fn}`)
          ? "impact=emit-container-changed"
          : "impact=none";
      edges.push({
        from: record._file,
        to: "app/hook/registry.py",
        via: `emit(HookPoint.${record.point}) in ${record.fn} (${impact})`,
        type: "hook-producer",
      });
    }
  }
  return { edges, consumersByPoint, producersByPoint };
};

/** 成员变更的冲击量行（文件 + 符号级清单）。 */
const memberImpactLines = (impactedPoints, consumersByPoint, producersByPoint) => {
  const lines = [];
  for (const point of impactedPoints) {
    if (point === "__REGISTRY__") {
      lines.push("  registry.py 本身变更——全部 HookPoint 成员的生产/消费关系需复核");
      continue;
    }
    const consumers = consumersByPoint.get(point) ?? [];
    const producers = producersByPoint.get(point) ?? [];
    const consumerFiles = [...new Set(consumers.map((c) => c._file))];
    const producerFiles = [...new Set(producers.map((p) => p._file))];
    lines.push(
      `  HookPoint.${point}: ${consumers.length} 个消费者符号 [${consumers.map((c) => `${c.fn}@${c._file}`).join(", ")}]` +
      (consumerFiles.length > 0 ? `（文件 ${consumerFiles.length}: ${consumerFiles.join(", ")}）` : ""),
    );
    lines.push(
      `    ${producers.length} 个生产者符号 [${producers.map((p) => `${p.fn}@${p._file}`).join(", ")}]` +
      (producerFiles.length > 0 ? `（文件 ${producerFiles.length}: ${producerFiles.join(", ")}）` : ""),
    );
  }
  return lines;
};

/** emit 容器变更的冲击量行（变更的 emit 调用点 → 该 HookPoint 的消费者）。 */
const containerImpactLines = (changedContainers, consumersByPoint, records) => {
  const lines = [];
  for (const containerKey of changedContainers) {
    const producersIn = records.filter(
      (r) => r.kind === "producer" && `${r._file}#${r.fn}` === containerKey,
    );
    const points = [...new Set(producersIn.map((p) => p.point))];
    for (const point of points) {
      const consumers = consumersByPoint.get(point) ?? [];
      lines.push(
        `  容器 ${containerKey} 变更（emit 调用点）→ HookPoint.${point} 的 ${consumers.length} 个消费者 [${consumers.map((c) => `${c.fn}@${c._file}`).join(", ")}]`,
      );
    }
  }
  return lines;
};

export default {
  // change-surface.v1 不放入 requires：非变更模式下 facts 未注入（unavailable），
  // 规则仍做全量发现；变更模式下注入（available）才做冲击量分析。
  stages: {
    text: ({ files, allFiles }) => {
      // 消费者图需要全量 records × 变更面交叉：变更模式下 files 是变更文件
      // （默认聚焦），消费者可能在未变更文件——显式取 allFiles 全量候选。
      return allFiles ?? files;
    },
    ast: {
      // 三根查询：@hook 装饰器（带方法名）+ 函数体内直接 emit + await 包着的 emit
      pattern: `
(decorated_definition
  (decorator (call function: (identifier) @fn arguments: (argument_list (attribute object: (identifier) @argobj attribute: (identifier) @argattr) @arg)) @dec)
  (function_definition name: (identifier) @name)) @def
(function_definition
  name: (identifier) @fname
  (block (call function: (attribute attribute: (identifier) @attr) arguments: (argument_list (attribute object: (identifier) @argobj2 attribute: (identifier) @argattr2) @arg2)) @call)) @func
(function_definition
  name: (identifier) @fname2
  (block (_ (call function: (attribute attribute: (identifier) @attr2) arguments: (argument_list (attribute object: (identifier) @argobj3 attribute: (identifier) @argattr3) @arg3)) @call2))) @func2`,
      extract: (matches) => {
        const records = [];
        for (const match of matches) {
          const byName = (n) => match.captures.find((c) => c.name === n)?.text;
          const fn = byName("fn");
          if (fn === "hook" && byName("argobj") === "HookPoint") {
            records.push({
              kind: "consumer",
              point: byName("argattr"),
              fn: byName("name"),
              line: match.startLine,
            });
            continue;
          }
          const attr = byName("attr") ?? byName("attr2");
          const argobj = byName("argobj2") ?? byName("argobj3");
          const argattr = byName("argattr2") ?? byName("argattr3");
          if (attr === "emit" && argobj === "HookPoint") {
            records.push({
              kind: "producer",
              point: argattr,
              fn: byName("fname") ?? byName("fname2"),
              line: match.startLine,
            });
          }
        }
        return records;
      },
    },
  },
  link: ({ facts, records }) => {
    const surface = facts.changeSurface;
    if (surface?.availability !== "available") return discoveryEdges(records);
    const impactedPoints = impactedPointsFor(surface);
    const changedContainers = changedContainersFor(surface);
    const { edges, consumersByPoint, producersByPoint } = changeEdges(records, impactedPoints, changedContainers);
    if (impactedPoints.size > 0 || changedContainers.size > 0) {
      const lines = ["[consumer-pattern] 变更冲击量:"];
      lines.push(...memberImpactLines(impactedPoints, consumersByPoint, producersByPoint));
      lines.push(...containerImpactLines(changedContainers, consumersByPoint, records));
      console.error(lines.join("\n"));
    }
    return edges;
  },
};

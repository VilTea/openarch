// @openarch-template: TS EventBus 发布订阅
// @description 识别 EventBus.emit → .on 的隐式事件依赖边
// @param emitter_class     发射器类名  (如 EventBus / emitter / bus)
// @param emit_method       发布方法名  (如 emit / dispatch)
// @param on_method         订阅方法名  (如 on / subscribe)

// 引擎按 text → ast → link 顺序执行，不可跳过或重排。
// text 和 ast 可选（不导出则跳过该级），link 必填。
export default {
  stages: {
  // ── 级1 文本筛（引擎对全量 files 只跑一次）──
  text({ files, text }) {
    return files.filter(f => /\b({{emit_method}}|{{on_method}})\b/.test(text(f)));
  },

  // ── 级2 AST query（引擎只对级1 输出跑，逐文件 query + extract）──
  ast: {
    // 一条 query 同时匹配 emit 和 on 调用，捕获 @role + @event
    pattern: `(call_expression
  function: (member_expression
    object: (identifier) @obj (#eq? @obj "{{emitter_class}}")
    property: (property_identifier) @role (#match? @role "^({{emit_method}}|{{on_method}})$"))
  arguments: (arguments (string) @event))`,

    extract(matches, file) {
      return matches.map(m => {
        const role = m.captures.find(c => c.name === "role")?.text ?? "";
        const event = (m.captures.find(c => c.name === "event")?.text ?? "").replace(/^["']|["']$/g, "");
        return { file, role, event };
      });
    },
  },

  },

  // ── 级3 语义连接（引擎传入级2 提取的所有记录）──
  link({ records, log }) {
    const edges = [];
    const emits = records.filter(r => r.role === "{{emit_method}}");
    const listeners = records.filter(r => r.role === "{{on_method}}");
    const listenerEvents = new Set(listeners.map(l => l.event));

    for (const emit of emits) {
      if (listenerEvents.has(emit.event)) {
        for (const l of listeners.filter(l => l.event === emit.event)) {
          edges.push({
            from: emit._file,
            to: l._file,
            via: `event:${emit.event}`,
            type: "event_bus",
          });
        }
      }
    }
    log(`${edges.length} 边`);
    return edges;
  },
};

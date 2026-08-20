/**
 * OpenArch DSH 插件 — 治理可视化层（Client）。
 *
 * 两个 UI 占位：
 * - conversation.composer.dock "openarch-governance"：composer 卡片**下方**的
 *   常驻状态条（对话最底部；baseline 新鲜度 / 变更 / 策略），点击展开看板。
 * - conversation.composer.dock "openarch-governance"：状态条（baseline 徽章/变更/rules），点击开合看板
 * - shell.overlay            "openarch-dashboard"：全局治理看板
 *   （概览统计卡、P95 校准对照、结构 Top-N、Σ|ΔI| 趋势 sparkline 与分布）。
 *
 * 数据通道（与 Host 侧 openarch-tools 的注册一一对应）：
 * - 动态包：host.call("openarch/governance-state")（同包 Host 半注册的
 *   harness.handle；动态 Client 半没有网络，fetch 不可用）
 * - 静态打包：host 缺失时回落 fetch("/api/openarch/governance-state")
 *
 * HTML5/现代特性：<details>/<summary> 折叠分区、<meter> 扫描进度、
 * <time datetime> 语义时间、内联 SVG 趋势 sparkline、CSS Grid 统计卡。
 * 交互：直方图桶悬停浮动详情（区间/文件数/占比）、sparkline 悬停
 * 高亮点 + 引导线 + 浮动明细（日期/Σ|ΔI|/最大冲击文件/恶化改善）；
 * 各分区带一行解释性说明（hint），指标标签带 title 释义。
 * 文案当前硬编码中文（i18n 字典列为 v2，且动态包勿注册 locale 命名空间）。
 *
 * 约定：本文件是纯 JavaScript、零 import 的 Cordis Client 插件源文件。
 * - 动态运行：去掉底部 export 行，把函数体放进返回 { inject, apply } 的包即可。
 *   组件使用 Builtin 提供的 React（createElement/useState/useEffect）、
 *   host.call 与 styles.insert。
 * - 静态打包：打包器注入 React（import * as React from "react"）；
 *   host/styles 经 typeof 探测缺失时分别回退 fetch 路由 / 跳过样式注入。
 *
 * v1 刻意不做 tool.call.toolview 卡片接管：工具卡由 Host 的
 * presentCall/presentResult 提供（避免遮蔽报告正文），列为 v2。
 */

export const name = "openarch-dashboard";

/** timer 与 slots 是硬依赖：轮询计时与看板槽位注册都依赖它们。 */
export const inject = ["timer", "slots"];

const fmt = (value, digits = 1) => (typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 10 ** digits) / 10 ** digits) : "?");

const shortPath = (path) => {
  if (typeof path !== "string") return "?";
  const parts = path.split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
};

const dateOf = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "?");

/** 浮动气泡视口钳制：固定定位气泡不被面板/分区裁剪，但要保持在窗口内。 */
const viewportWidth = () => (typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1200);
const clampTipX = (x) => Math.max(150, Math.min(viewportWidth() - 150, x));
const clampTipY = (y) => Math.max(8, y);

/** 指标释义（label 悬停 title）；面向新手，不复读指标名。 */
const METRIC_TITLES = {
  branch: "分支复杂度：一个函数里有多少条不同执行路径；越高越难理解。",
  nesting: "嵌套深度：代码一层套一层的深度；越深越难读。",
  loc: "有效代码行数：去掉空行和注释后真正有代码的行数。",
  alpha: "暴露度 α：这个文件被多少其他文件依赖/影响的可能程度；越高越像结构枢纽。",
  oneMinusConnectedness: "不连通形态：1 − 内部连接度；越高表示文件内部各函数之间联系越弱。",
  externalPassthrough: "外部透传调用数：这个文件直接调用外部模块/API 的次数；越高对外依赖越重。",
};

/** P95 六项指标（v5.3 口径，与 α_struct / localBurden 统一口径对齐）。 */
const P95_METRICS = ["branch", "nesting", "loc", "alpha", "oneMinusConnectedness", "externalPassthrough"];

/** 单个工作区根目录的状态仓：轮询 + 订阅（面板开合状态上提到 hub）。 */
function makeStore(ctx, refreshMs, root) {
  let state = null;
  let error = null;
  let started = false;
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const stateUrl = (force) => {
    const query = new URLSearchParams();
    if (root) query.set("root", root);
    if (force) query.set("force", "1");
    const suffix = query.toString();
    return `/api/openarch/governance-state${suffix ? `?${suffix}` : ""}`;
  };

  const fetchState = async (force = false) => {
    // 动态包内置 host.call（同包 Host 半的 harness.handle）；静态打包回退 HTTP 路由。
    const rpc = typeof host !== "undefined" && host !== null && typeof host.call === "function" ? host : null;
    if (rpc !== null) {
      try {
        return await rpc.call("openarch/governance-state", {
          ...(root ? { root } : {}),
          ...(force ? { force: true } : {}),
        });
      } catch (cause) {
        // 动态 Client 半无网络：fetch 不可用时这里会得到运行器给的明确错误。
      }
    }
    const response = await fetch(stateUrl(force), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const refresh = async (force = false) => {
    try {
      state = await fetchState(force);
      error = null;
    } catch (cause) {
      error = String(cause && cause.message ? cause.message : cause);
    } finally {
      emit();
    }
  };

  return {
    ensureStarted() {
      if (started) return;
      started = true;
      refresh();
      ctx.interval(refresh, refreshMs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    getState: () => state,
    getError: () => error,
  };
}

const normalizeRoot = (root) => (typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "");

/**
 * 多工作区状态仓中枢：每个工作区根一份独立 store（各自轮询/TTL 语义），
 * 面板跟随"活动 root"，每个会话的 dock 读自己工作区的 store——
 * 多项目并存时"点到哪个项目，看板/状态条反映哪个项目"。
 */
function createStoreHub(ctx, refreshMs) {
  const stores = new Map();
  let activeRoot = null;
  let open = false;
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const forRoot = (root) => {
    const key = normalizeRoot(root);
    if (key.length === 0) return null;
    let store = stores.get(key);
    if (!store) {
      store = makeStore(ctx, refreshMs, root);
      stores.set(key, store);
      if (stores.size > 8) {
        stores.delete(stores.keys().next().value);
      }
    }
    return store;
  };

  const DEFAULT_KEY = "__default__";
  // 无工作区信息（动态环境 slot 可能不带 props）时的兜底：不带 root 参数，
  // host 端回落其默认 cwd（workspaceRegistry 探测）。
  const defaultStore = () => {
    let store = stores.get(DEFAULT_KEY);
    if (!store) {
      store = makeStore(ctx, refreshMs, null);
      stores.set(DEFAULT_KEY, store);
    }
    return store;
  };

  return {
    forRoot,
    defaultStore,
    activeStore: () => (activeRoot !== null ? stores.get(activeRoot) : undefined),
    openPanel(root) {
      activeRoot = root ? normalizeRoot(root) : DEFAULT_KEY;
      open = true;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isOpen: () => open,
    setOpen(next) {
      if (open !== next) {
        open = next;
        emit();
      }
    },
  };
}

const useStoreVersion = (store) => {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), [store]);
  return version;
};

/** OpenArch 徽标（渐变小方块）。 */
function Mark({ className }) {
  return React.createElement("span", { className: className ?? "oa-mark", "aria-hidden": true }, "◈");
}

/** 状态点：stale 时带脉冲波纹。 */
function StatusDot({ stale }) {
  return React.createElement("span", { className: `oa-dot${stale ? " oa-dot-pulse" : ""} oa-dot-${stale ? "warn" : "ok"}` });
}

/** 从 slot props 解析本会话所属工作区路径（会话归属优先，其次最近工作区）。 */
function workspaceRootOf(props, workspacesState) {
  const sessionId = props?.sessionId ?? props?.session?.sessionId ?? undefined;
  const items = Array.isArray(workspacesState?.items) ? workspacesState.items : [];
  if (sessionId !== undefined) {
    const owner = items.find((w) => Array.isArray(w.sessions) && w.sessions.some((id) => id === sessionId));
    if (owner && typeof owner.path === "string") return owner.path;
  }
  const recent = workspacesState?.recentWorkspaceId;
  const recentWs = items.find((w) => w.workspaceId === recent);
  if (recentWs && typeof recentWs.path === "string") return recentWs.path;
  return null;
}

/** composer 下方状态条：每个会话读自己工作区的状态；未初始化/无数据时渲染 null。 */
function GovernanceDock({ hub, props }) {
  useStoreVersion(hub);
  // useWorkspaces 是 slot owner 注入的选择器 hook（渲染期读取当前工作区列表）。
  const workspacesState = typeof props?.useWorkspaces === "function" ? props.useWorkspaces((s) => s) : null;
  const root = workspaceRootOf(props, workspacesState);
  // 动态环境 slot 可能不带 props → 兜底默认工作区（host 默认 cwd）。
  const store = root !== null ? hub.forRoot(root) : hub.defaultStore();
  useStoreVersion(store);
  store.ensureStarted();
  const state = store.getState();
  const error = store.getError();
  if (state === null) {
    if (error === null) return null;
    return React.createElement("div", { className: "oa-dock oa-dock-error" }, `OpenArch 状态读取失败: ${error}`);
  }
  if (!state.initialized) return null;
  const cli = state.cli?.ok ? state.cli.context : null;
  const baseline = cli?.baseline ?? null;
  const changes = cli?.changes ?? null;
  const policy = cli?.architecturePolicy ?? null;
  const fresh = baseline?.freshness === "fresh";
  const files = typeof baseline?.files === "number" ? baseline.files : "?";
  const wtPaths = typeof changes?.worktree?.paths === "number" ? changes.worktree.paths : 0;
  const wtSrc = typeof changes?.worktree?.sourcePaths === "number" ? changes.worktree.sourcePaths : 0;
  const stPaths = typeof changes?.staged?.paths === "number" ? changes.staged.paths : 0;
  const rules = policy?.declaredRules ?? "?";
  const readiness = Array.isArray(cli?.readiness) ? cli.readiness : [];
  const notReady = readiness.filter((r) => r && typeof r.state === "string" && r.state !== "ready").map((r) => r.id);

  return React.createElement(
    "div",
    { className: "oa-dock" },
    React.createElement(
      "button",
      {
        type: "button",
        className: "oa-dock-button",
        "aria-expanded": hub.isOpen(),
        title: `OpenArch 治理看板（${root ?? "?"}；点击开合）`,
        onClick: () => (hub.isOpen() ? hub.setOpen(false) : hub.openPanel(root)),
      },
      React.createElement(Mark, null),
      React.createElement("span", { className: "oa-dock-name" }, "OpenArch"),
      React.createElement("span", { className: "oa-dock-sep" }),
      React.createElement("span", { className: "oa-dock-chip", title: `baseline ${files} 个文件；${fresh ? "fresh（最新）" : "stale（有变更未纳入基线，可用 openarch_scan 更新）"}` },
        React.createElement(StatusDot, { stale: !fresh }),
        React.createElement("span", null, `${files} files · ${fresh ? "fresh" : "stale"}`),
      ),
      React.createElement("span", { className: "oa-dock-chip", title: "变更计数：工作树 wt（源文件数）· 暂存 st" },
        React.createElement("span", { className: "oa-chip-glyph" }, "Δ"),
        React.createElement("span", null, `wt ${wtPaths}/${wtSrc} · st ${stPaths}`),
      ),
      React.createElement("span", { className: "oa-dock-chip", title: "已声明的结构策略规则数（config.yml structural_policies）" },
        React.createElement("span", { className: "oa-chip-glyph" }, "#"),
        React.createElement("span", null, `${rules} rules`),
      ),
      ...(notReady.length > 0 ? [React.createElement("span", { className: "oa-dock-chip oa-dock-warn", title: `readiness 未就绪: ${notReady.join(", ")}（如 code-hook 未装时提交不经过门禁）` },
        React.createElement("span", { className: "oa-chip-glyph" }, "!"),
        React.createElement("span", null, `readiness ${notReady.join(",")}`),
      )] : []),
      React.createElement("span", { className: `oa-dock-chevron${hub.isOpen() ? " oa-dock-chevron-open" : ""}` }, "▾"),
    ),
  );
}

/** 概览统计卡；hint 是面向新手的通俗说明，不复读卡片内容。 */
function StatCard({ label, value, sub, hint }) {
  const title = hint ?? `${label}: ${value}${sub ? ` · ${sub}` : ""}`;
  return React.createElement(
    "div",
    { className: "oa-stat", title },
    React.createElement("span", { className: "oa-stat-label" }, label),
    React.createElement("span", { className: "oa-stat-value" }, value),
    sub ? React.createElement("span", { className: "oa-stat-sub" }, sub) : null,
  );
}

/** 折叠分区（HTML5 details/summary）；hint 为一行解释性说明。 */
function Section({ title, children, open, hint }) {
  return React.createElement(
    "details",
    { className: "oa-sec", open },
    React.createElement("summary", null, title),
    React.createElement(
      "div",
      { className: "oa-sec-body" },
      hint ? React.createElement("div", { className: "oa-sec-hint" }, hint) : null,
      children,
    ),
  );
}

/** P95 指标：渐变填充 + gate 刻度线；标签与轨道带释义。 */
function MetricBar({ label, current, gate, max }) {
  const widthOf = (value) => `${Math.max(3, Math.min(100, (Number.isFinite(value) ? value : 0) / max * 100))}%`;
  const gatePct = Math.min(97, (Number.isFinite(gate) ? gate : 0) / max * 100);
  const overGate = Number.isFinite(current) && Number.isFinite(gate) && current > gate;
  return React.createElement(
    "div",
    { className: "oa-metric" },
    React.createElement("div", { className: "oa-metric-head" },
      React.createElement("span", { className: "oa-metric-label", title: METRIC_TITLES[label] ?? label }, label),
      React.createElement("span", { className: "oa-metric-values" },
        React.createElement("span", { className: "oa-metric-cur", title: "当前项目 P95 值：大多数文件都没有超过这个数。" }, fmt(current)),
        React.createElement("span", { className: "oa-metric-gate", title: "项目参考线：超过它说明当前复杂程度已高于项目自己设定的基准。" }, `gate ${fmt(gate)}`),
      ),
    ),
    React.createElement("div", {
      className: "oa-track",
      title: overGate
        ? `当前值已超过项目参考线（current ${fmt(current)} > gate ${fmt(gate)}），说明最复杂的一批文件需要关注。`
        : `当前值仍在项目参考线以内（current ${fmt(current)} ≤ gate ${fmt(gate)}）。`,
    },
      React.createElement("div", { className: "oa-track-fill", style: { width: widthOf(current) } }),
      React.createElement("span", { className: "oa-track-gate", style: { left: `${gatePct}%` }, title: "项目参考线：超过它表示复杂度过高。" }),
    ),
  );
}

/** 结构 Top-N 行：排名徽章 + 路径 + 指标 + 行内 mini 条。 */
function TopRow({ row, rank, maxBranch }) {
  const rankClass = rank <= 3 ? ` oa-rank-${rank}` : "";
  const miniWidth = `${Math.max(3, Math.min(100, (Number.isFinite(row.branchCount) ? row.branchCount : 0) / maxBranch * 100))}%`;
  const rowTitle = [
    row.path ?? "",
    `branch=${fmt(row.branchCount)} 分支数`,
    `loc=${fmt(row.loc, 0)} 有效代码行`,
    `nest=${fmt(row.nestingDepth, 0)} 嵌套深度`,
    `α=${fmt(row.alphaStruct, 2)} 暴露度`,
    `declLoc=${fmt(row.declarationLoc, 0)} 声明代码行`,
    `extPass=${fmt(row.externalPassthroughCalls, 0)} 外部调用数`,
  ].join("\n");
  return React.createElement(
    "div",
    { className: "oa-top-row", title: rowTitle },
    React.createElement("span", { className: `oa-rank${rankClass}` }, String(rank)),
    React.createElement("span", { className: "oa-mono oa-top-path" }, shortPath(row.path)),
    React.createElement("span", { className: "oa-top-cell" },
      React.createElement("span", { className: "oa-top-num" }, fmt(row.branchCount)),
      React.createElement("span", { className: "oa-mini" }, React.createElement("span", { className: "oa-mini-fill", style: { width: miniWidth } })),
    ),
    React.createElement("span", { className: "oa-top-num" }, fmt(row.loc, 0)),
    React.createElement("span", { className: "oa-top-num" }, fmt(row.nestingDepth, 0)),
    React.createElement("span", { className: "oa-top-num" }, fmt(row.alphaStruct, 2)),
    React.createElement("span", { className: "oa-top-num" }, fmt(row.declarationLoc, 0)),
    React.createElement("span", { className: "oa-top-num" }, fmt(row.externalPassthroughCalls, 0)),
  );
}

/**
 * Σ|ΔI| 趋势 sparkline（内联 SVG：渐变面积 + 折线）。
 * 悬停：高亮点 + 垂直引导线 + 浮动明细（日期/Σ|ΔI|/最大冲击文件/恶化改善）。
 * points: [{ value, entry }]，按时间升序（左旧右新）。
 */
function Sparkline({ points }) {
  const [hover, setHover] = React.useState(null); // { index, x, y }（x/y 为视口坐标）
  if (!Array.isArray(points) || points.length < 2) return null;
  const width = 560;
  const height = 44;
  const pad = 3;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const step = (width - pad * 2) / (points.length - 1);
  const xOf = (i) => pad + i * step;
  const yOf = (v) => height - pad - (v / max) * (height - pad * 2);
  const linePoints = points.map((p, i) => `${xOf(i)},${yOf(p.value)}`).join(" ");
  const area = `${pad},${height - pad} ${linePoints} ${width - pad},${height - pad}`;
  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const viewX = (event.clientX - rect.left) / rect.width * width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((viewX - pad) / step)));
    setHover({
      index,
      x: rect.left + (xOf(index) / width) * rect.width,
      y: rect.top + (yOf(values[index]) / height) * rect.height,
    });
  };
  const hoverEntry = hover !== null ? points[hover.index].entry : null;
  const hoverX = hover !== null ? xOf(hover.index) : 0;
  return React.createElement(
    "div",
    { className: "oa-spark-wrap" },
    React.createElement(
      "svg",
      {
        className: "oa-spark",
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "none",
        onMouseMove: onMove,
        onMouseLeave: () => setHover(null),
      },
      React.createElement(
        "defs",
        null,
        React.createElement(
          "linearGradient",
          { id: "oa-spark-grad", x1: "0", y1: "0", x2: "0", y2: "1" },
          React.createElement("stop", { offset: "0%", stopColor: "#5b9dff", stopOpacity: 0.28 }),
          React.createElement("stop", { offset: "100%", stopColor: "#5b9dff", stopOpacity: 0.02 }),
        ),
      ),
      React.createElement("polygon", { points: area, fill: "url(#oa-spark-grad)" }),
      React.createElement("polyline", { points: linePoints, className: "oa-spark-line" }),
      hover !== null ? React.createElement("line", { className: "oa-spark-guide", x1: hoverX, y1: 0, x2: hoverX, y2: height }) : null,
      hover !== null ? React.createElement("circle", { className: "oa-spark-dot", cx: hoverX, cy: yOf(values[hover.index]), r: 3.5 }) : null,
    ),
    hover !== null && hoverEntry
      ? React.createElement(
          "div",
          { className: "oa-spark-tip", style: { left: clampTipX(hover.x), top: clampTipY(hover.y + 14) } },
          React.createElement("div", { className: "oa-spark-tip-date" }, `${dateOf(hoverEntry.timestamp)} · Σ|ΔI| ${fmt(hoverEntry.sumAbsDeltaI)}`),
          React.createElement("div", { className: "oa-spark-tip-file" }, `最大冲击 ${shortPath(hoverEntry.maxDeltaFile)}`),
          React.createElement("div", { className: "oa-spark-tip-det" }, `恶化 +${fmt(hoverEntry.deterioration, 2)} · 改善 −${fmt(hoverEntry.improvement, 2)} · ${hoverEntry.files} 文件`),
        )
      : null,
  );
}

/** 变更冲击历史：sparkline + 最近 8 条明细（改善/恶化着色彩片）。 */
function HistorySection({ history }) {
  const recent = (Array.isArray(history) ? history : []).slice(0, 8);
  const points = [...recent].reverse().map((entry) => ({ value: Math.abs(entry.sumAbsDeltaI ?? 0), entry }));
  const histMaxDelta = Math.max(1, ...recent.map((h) => Math.abs(h.sumAbsDeltaI ?? 0)));
  return React.createElement(
    Section,
    {
      title: `变更冲击历史 Σ|ΔI|（最近 ${recent.length} 次）`,
      open: true,
      hint: "每次 check --staged 封存的变更冲击证据（非 git commit 列表）；Σ|ΔI| 为 I_push 上界求和，折线左旧右新，悬停看明细。",
    },
    React.createElement(Sparkline, { points }),
    recent.length === 0
      ? React.createElement("div", { className: "oa-panel-note" }, "暂无 history 记录。")
      : recent.map((entry) => React.createElement(
          "div",
          { key: entry.entryId ?? entry.timestamp ?? Math.random(), className: "oa-hist-row" },
          React.createElement("div", { className: "oa-hist-head" },
            React.createElement("time", { dateTime: entry.timestamp ?? undefined, className: "oa-hist-date" }, dateOf(entry.timestamp)),
            React.createElement("span", { className: "oa-hist-file", title: entry.maxDeltaFile ?? "" }, shortPath(entry.maxDeltaFile)),
            React.createElement("span", { className: "oa-hist-value" }, `Σ|ΔI| ${fmt(entry.sumAbsDeltaI)}`),
          ),
          React.createElement("div", { className: "oa-hist-track" },
            React.createElement("div", { className: "oa-hist-fill", style: { width: `${Math.round(Math.abs(entry.sumAbsDeltaI ?? 0) / histMaxDelta * 100)}%` } }),
          ),
          (entry.deterioration !== 0 || entry.improvement !== 0 || (entry.scale && entry.scale.intensity !== null))
            ? React.createElement("div", { className: "oa-hist-chips" },
                entry.deterioration ? React.createElement("span", { className: "oa-chip oa-chip-det" }, `恶化 +${fmt(entry.deterioration, 2)}`) : null,
                entry.improvement ? React.createElement("span", { className: "oa-chip oa-chip-imp" }, `改善 −${fmt(entry.improvement, 2)}`) : null,
                entry.scale && entry.scale.intensity !== null
                  ? React.createElement("span", { className: "oa-chip oa-chip-scale", title: "冲击强度 = I_push / severityBudget（本次变更的语义破坏度）" }, `强度 ${fmt(entry.scale.intensity, 2)}`)
                  : null,
              )
            : null,
        )),
  );
}

/** branchCount 分布直方图（渐变列 + 悬停浮动详情：区间/文件数/占比）。 */
function Distribution({ distribution }) {
  const [hover, setHover] = React.useState(null); // { index, x, y }（x/y 为视口坐标）
  if (!distribution || !Array.isArray(distribution.buckets) || distribution.buckets.length === 0) return null;
  const max = Math.max(...distribution.buckets.map((bucket) => bucket.count), 1);
  const base = typeof distribution.count === "number" ? distribution.count : 0;
  const hovered = hover !== null ? distribution.buckets[hover.index] : null;
  const hoveredPct = hovered && base > 0 ? Math.round(hovered.count / base * 1000) / 10 : 0;
  return React.createElement(
    "div",
    { className: "oa-dist" },
    React.createElement(
      "div",
      { className: "oa-dist-bars" },
      distribution.buckets.map((bucket, index) => {
        const pct = base > 0 ? Math.round(bucket.count / base * 1000) / 10 : 0;
        return React.createElement(
          "span",
          {
            key: index,
            className: "oa-dist-bar",
            style: { height: `${Math.max(4, Math.round(bucket.count / max * 100))}%` },
            onMouseEnter: (event) => setHover({ index, x: event.clientX, y: event.clientY }),
            onMouseLeave: () => setHover(null),
            title: `${bucket.from}–${bucket.to}: ${bucket.count} 个文件（${pct}%）`,
          },
          null,
        );
      }),
    ),
    hovered
      ? React.createElement(
          "div",
          { className: "oa-dist-tip", style: { left: clampTipX(hover.x), top: clampTipY(hover.y - 10) } },
          React.createElement("b", null, `${fmt(hovered.from)} – ${fmt(hovered.to)}`),
          React.createElement("br", null),
          `${hovered.count} 个文件 · ${hoveredPct}%`,
        )
      : null,
    React.createElement("div", { className: "oa-dist-scale" },
      React.createElement("span", null, fmt(distribution.min)),
      React.createElement("span", { className: "oa-dist-mean" }, `mean ${fmt(distribution.mean)} · n=${distribution.count ?? "?"}`),
      React.createElement("span", null, fmt(distribution.max)),
    ),
  );
}

/** 测试治理观察分区：最近一次 openarch_test 的有界投影（只读，不进入任何 gate）。 */
function TestGovernanceSection({ test }) {
  const cov = test?.coverage ?? {};
  const decision = test?.decision ?? {};
  const providers = Array.isArray(test?.providers) ? test.providers : [];
  const summaries = Array.isArray(test?.summaries) ? test.summaries : [];
  const triggeredKinds = [...new Set((decision.triggered ?? []).map((t) => `${t.level}:${t.kind}`))];
  const status = typeof test?.verdict === "string" ? test.verdict : "?";
  return React.createElement(
    "div",
    { className: "oa-tg" },
    React.createElement(
      "div",
      { className: "oa-tg-head" },
      React.createElement("span", { className: `oa-verdict oa-verdict-${status.toLowerCase()}` }, status),
      React.createElement("span", null,
        `覆盖 ${cov.status ?? "?"} · 测试文件 ${cov.testFiles ?? "?"} · provider 处理 ${cov.providerHandledTestFiles ?? "?"} · 未纳入 baseline ${cov.unbaselinedTestFiles ?? "?"} · 未识别 ${cov.unrecognizedTestFiles ?? "?"} · 失败 ${cov.failedTestFiles ?? "?"}`,
      ),
    ),
    cov.reasons?.length > 0
      ? React.createElement("div", { className: "oa-tg-note" }, `覆盖限制: ${cov.reasons.join(", ")}`)
      : null,
    providers.length > 0
      ? React.createElement(
          "div",
          { className: "oa-tg-rows" },
          React.createElement(
            "div",
            { className: "oa-tg-row oa-tg-row-head" },
            React.createElement("span", { className: "oa-mono" }, "provider"),
            React.createElement("span", null, "status"),
            React.createElement("span", { className: "oa-tg-num" }, "cand"),
            React.createElement("span", { className: "oa-tg-num" }, "handled"),
            React.createElement("span", { className: "oa-tg-num" }, "miss"),
            React.createElement("span", { className: "oa-tg-num" }, "fail"),
          ),
          providers.map((p) => React.createElement(
            "div",
            { key: p.providerId ?? "?", className: "oa-tg-row" },
            React.createElement("span", { className: "oa-mono" }, p.providerId ?? "?"),
            React.createElement("span", null, p.status ?? "?"),
            React.createElement("span", { className: "oa-tg-num" }, String(p.candidates ?? "?")),
            React.createElement("span", { className: "oa-tg-num" }, String(p.handled ?? "?")),
            React.createElement("span", { className: "oa-tg-num" }, String(p.missingBaseline ?? "?")),
            React.createElement("span", { className: "oa-tg-num" }, String(p.failed ?? "?")),
          )),
        )
      : null,
    summaries.length > 0
      ? React.createElement("div", { className: "oa-tg-note" },
          summaries.map((s) => {
            const p95 = s.p95;
            const p95Text = p95
              ? `loc=${p95.loc?.toFixed(1)} assertion=${p95.assertionCount?.toFixed(1)} mock=${p95.mockCount?.toFixed(1)}`
              : "UNAVAILABLE";
            return `[${s.providerId}] cases=${s.testCases ?? "?"} P95 ${p95Text}`;
          }).join(" · "),
        )
      : null,
    test?.suggestedAdapters
      ? React.createElement("div", { className: "oa-tg-note" },
          `适配器建议（确认框架后显式写入 config.yml，勿自动启用）: providers=[${(test.suggestedAdapters.providers ?? []).join(", ") || "无"}] runners=[${(test.suggestedAdapters.runners ?? []).join(", ") || "无"}]`,
        )
      : null,
    test?.bloat
      ? React.createElement("div", { className: "oa-tg-note" },
          `TEST_BLOAT ${Number(test.bloat.score).toFixed(3)}${test.bloat.triggered ? "（已触发，观察并治理）" : "（正常范围）"}`,
        )
      : null,
    React.createElement("div", { className: "oa-tg-note" },
      `决策: finding=${decision.findingCount ?? "?"}${triggeredKinds.length > 0 ? ` · 触发 ${triggeredKinds.join(", ")}` : ""} · 只读观察，不据此自动加 BLOCK`,
    ),
  );
}

/** 全局治理看板（shell.overlay 占位，click-through 层上自行接管指针事件）。 */
function GovernancePanel({ hub }) {
  useStoreVersion(hub);
  const store = hub.activeStore() ?? hub.defaultStore();
  useStoreVersion(store);
  if (!hub.isOpen()) return null;
  const state = store.getState();
  const error = store.getError();
  const closeButton = React.createElement("button", { type: "button", className: "oa-panel-button", onClick: () => hub.setOpen(false) }, "关闭");

  const header = (extra) => React.createElement(
    "div",
    { className: "oa-panel-header" },
    React.createElement("span", { className: "oa-panel-title" },
      React.createElement(Mark, null),
      React.createElement("span", null, "OpenArch 治理看板"),
    ),
    React.createElement("div", { className: "oa-panel-actions" }, extra, closeButton),
  );

  if (state === null || !state.initialized) {
    return React.createElement(
      "div",
      { className: "oa-panel", role: "dialog", "aria-label": "OpenArch 治理看板" },
      header(null),
      React.createElement("div", { className: "oa-panel-body" },
        React.createElement("div", { className: "oa-panel-note" },
          state === null ? (error === null ? "后台采集中…" : `状态读取失败: ${error}`) : "当前工作区未初始化 OpenArch。"),
      ),
    );
  }

  const cli = state.cli?.ok ? state.cli.context : null;
  const baseline = cli?.baseline ?? null;
  const p95 = state.baseline?.calibration ?? null;
  const policies = state.baseline?.policyCalibrations ?? null;
  const policyIds = policies && typeof policies === "object" ? Object.keys(policies) : [];
  const history = Array.isArray(state.history) ? state.history : [];
  const top = Array.isArray(state.top) ? state.top : [];
  const scanStatus = state.scanStatus;
  const fresh = baseline?.freshness === "fresh";
  const metrics = P95_METRICS;
  const maxOf = (cal) => Math.max(1, ...metrics.map((m) => Math.max(
    Number.isFinite(cal?.current?.[m]) ? cal.current[m] : 0,
    Number.isFinite(cal?.gate?.[m]) ? cal.gate[m] : 0,
  )));
  const p95Max = maxOf(p95);
  const readiness = Array.isArray(cli?.readiness) ? cli.readiness : [];
  const notReady = readiness.filter((r) => r && typeof r.state === "string" && r.state !== "ready").map((r) => r.id);
  const maxBranch = Math.max(1, ...top.map((row) => (Number.isFinite(row.branchCount) ? row.branchCount : 0)));

  return React.createElement(
    "div",
    { className: "oa-panel", role: "dialog", "aria-label": "OpenArch 治理看板" },
    header(React.createElement("button", { type: "button", className: "oa-panel-button", onClick: () => store.refresh(true) }, "刷新")),
    React.createElement(
      "div",
      { className: "oa-panel-body" },
      // 概览
      React.createElement(
        Section,
        {
          title: "概览",
          open: true,
          hint: "这里显示 OpenArch 从当前项目本地读取到的事实；数字都来自项目配置、扫描基线和 Git 变更。",
        },
        React.createElement("div", { className: "oa-stats" },
          React.createElement(StatCard, {
            label: "baseline",
            value: `${typeof baseline?.files === "number" ? baseline.files : "?"} files`,
            sub: `${fresh ? "fresh" : "stale"} · ${dateOf(baseline?.scanAt)}`,
            hint: "OpenArch 扫描过的项目文件总数。fresh 表示基线是最新的；stale 表示工作区已有变化但还没重新扫描。",
          }),
          React.createElement(StatCard, {
            label: "生产 / 测试",
            value: `${state.baseline?.nProductionFiles ?? "?"} / ${state.baseline?.nTestFiles ?? "?"}`,
            sub: Array.isArray(state.baseline?.languages) ? state.baseline.languages.join(" · ") : undefined,
            hint: "被识别为生产代码和测试代码的文件数量；下面的语言是当前纳入 OpenArch 分析的编程语言。",
          }),
          React.createElement(StatCard, {
            label: "已声明策略",
            value: `${cli?.architecturePolicy?.declaredRules ?? "?"} rules`,
            sub: cli?.architecturePolicy?.state ?? undefined,
            hint: "项目 .openarch/config.yml 里声明的结构治理规则数量；state 表示这些规则当前是否处于强制执行状态。",
          }),
          React.createElement(StatCard, {
            label: "变更",
            value: `wt ${cli?.changes?.worktree?.paths ?? "?"} · st ${cli?.changes?.staged?.paths ?? "?"}`,
            sub: `源文件 ${cli?.changes?.worktree?.sourcePaths ?? "?"} / ${cli?.changes?.staged?.sourcePaths ?? "?"}`,
            hint: "wt=工作区里已修改但还没暂存的文件数；st=已经 git add 暂存的文件数。源文件指 OpenArch 会做结构分析的代码文件。",
          }),
        ),
        scanStatus && Number.isFinite(scanStatus.total) && scanStatus.total > 0
          ? React.createElement("div", { className: "oa-meter-row" },
              React.createElement("span", { className: "oa-meter-label" }, `最近一次 scan（${scanStatus.status ?? "?"}）`),
              React.createElement("meter", {
                className: "oa-meter",
                min: 0,
                max: scanStatus.total,
                value: scanStatus.completed ?? 0,
                title: `${scanStatus.completed ?? 0} / ${scanStatus.total}（${scanStatus.phase ?? "?"}）`,
              }),
              React.createElement("span", { className: "oa-meter-value" }, `${scanStatus.completed ?? 0}/${scanStatus.total}`),
            )
          : null,
        notReady.length > 0
          ? React.createElement("div", { className: "oa-caution" }, `⚠ 未就绪: ${notReady.join(", ")}（如 code-hook 未装时提交不经过门禁）`)
          : null,
        state.contractCatalog
          ? React.createElement("div", { className: "oa-contract-line", title: "上游机器契约目录（openarch contract --json）；对未知契约版本 fail-closed" },
              `契约 ${(state.contractCatalog.contracts ?? []).map((c) => `${c.id} ${c.version}`).join(" · ")} · openarch ${state.contractCatalog.openarchVersion ?? "?"}`,
            )
          : React.createElement("div", { className: "oa-contract-line" }, "上游契约目录不可用（已安装 openarch 无 contract 命令或解析失败）"),
      ),
      // P95 校准（v5.3 口径：per-policy sealed 校准优先，全局校准仅作概览回退）
      p95
        ? React.createElement(
            Section,
            {
              title: "P95 结构校准（current vs gate）",
              open: true,
              hint: "这些是 OpenArch 用来衡量代码复杂度的六项指标。current 是当前项目排在 95% 位置的数值（大多数文件都没超过）；gate 是项目自己设定的参考线。如果 current 超过 gate，说明最复杂的一批文件已经高于项目基准。",
            },
            policyIds.length > 0
              ? policyIds.map((id) => React.createElement(
                  "div",
                  { key: id, className: "oa-policy" },
                  React.createElement("div", { className: "oa-policy-title", title: `策略 ${id} 的 P95 参考线；current 超过 gate 表示该策略范围内最复杂文件高于基准。` }, id),
                  metrics.map((m) => React.createElement(MetricBar, { key: m, label: m, current: policies[id]?.current?.[m], gate: policies[id]?.gate?.[m], max: maxOf(policies[id]) })),
                ))
              : metrics.map((m) => React.createElement(MetricBar, { key: m, label: m, current: p95.current?.[m], gate: p95.gate?.[m], max: p95Max })),
          )
        : null,
      // 测试治理观察（最近一次 openarch_test；只读，不进入任何 gate）
      React.createElement(
        Section,
        {
          title: "测试治理（最近一次 openarch_test）",
          open: true,
          hint: "openarch_test --json 的只读观察面：覆盖/适配器建议/TEST_BLOAT。从不自动启用 provider 或据此新增 BLOCK；未运行时为空。",
        },
        state.testGovernance
          ? React.createElement(TestGovernanceSection, { test: state.testGovernance })
          : React.createElement("div", { className: "oa-panel-note" }, "尚未运行 openarch_test；运行后此分区显示覆盖、provider 处理面与适配器建议（只读观察）。"),
      ),
      // 结构 Top-N（branchCount 排名 + 局部负担输入列）
      top.length > 0
        ? React.createElement(
            Section,
            {
              title: `结构事实 Top-${top.length}（branchCount）`,
              open: true,
              hint: "按分支复杂度从高到低列出项目里最复杂的生产文件。数字越大表示这个文件的分支、体积、嵌套或对外依赖越重，越值得优先关注。",
            },
            React.createElement("div", { className: "oa-top-head" },
              React.createElement("span", null, "#"),
              React.createElement("span", { className: "oa-mono" }, "文件"),
              React.createElement("span", { className: "oa-top-num", title: "分支数：一个文件里所有函数的分支路径总量" }, "branch"),
              React.createElement("span", { className: "oa-top-num", title: "有效代码行数（去掉空行和注释）" }, "loc"),
              React.createElement("span", { className: "oa-top-num", title: "嵌套深度：代码一层套一层的深度" }, "nest"),
              React.createElement("span", { className: "oa-top-num", title: "暴露度：文件被其他代码依赖/影响的程度" }, "α"),
              React.createElement("span", { className: "oa-top-num", title: "声明代码行：只算声明部分的行数" }, "declLoc"),
              React.createElement("span", { className: "oa-top-num", title: "外部透传调用数：直接调用外部 API/模块的次数" }, "extPass"),
            ),
            top.map((row, index) => React.createElement(TopRow, { key: row.path ?? index, row, rank: index + 1, maxBranch })),
          )
        : null,
      // 变更冲击历史
      React.createElement(HistorySection, { history }),
      // 分布
      state.distribution
        ? React.createElement(
            Section,
            {
              title: "branchCount 分布",
              open: true,
              hint: "把项目里所有文件的分支数分成 10 个区间，显示每个区间的文件数量；悬停柱子可以看具体区间和占比。",
            },
            React.createElement(Distribution, { distribution: state.distribution.branchCount ?? null }),
          )
        : null,
      React.createElement("div", { className: "oa-panel-footer" },
        React.createElement("span", null, "数据来自 .openarch 本地事实（fail-closed）· 指标口径见 openarch skill 的 metrics-and-evidence"),
        React.createElement("span", null,
          React.createElement("time", { dateTime: state.collectedAt ?? undefined }, dateOf(state.collectedAt)),
          " · 每 20s 自动刷新",
        ),
      ),
    ),
  );
}

const CSS = `
.oa-mark{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#5b9dff,#46a758);color:#fff;font-size:11px;line-height:1;flex:none;box-shadow:0 1px 4px rgba(91,157,255,.35)}
.oa-dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:none}
.oa-dot-ok{background:var(--dsw-alias-text-success,#46a758)}
.oa-dot-warn{background:var(--dsw-alias-text-warning,#ffb224)}
.oa-dot-pulse{animation:oa-pulse 2s ease-out infinite}
@keyframes oa-pulse{0%{box-shadow:0 0 0 0 rgba(255,178,36,.45)}70%{box-shadow:0 0 0 6px rgba(255,178,36,0)}100%{box-shadow:0 0 0 0 rgba(255,178,36,0)}}
.oa-dock{display:inline-flex;align-items:center;gap:8px;margin:0 0 2px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));border-radius:999px;background:linear-gradient(180deg,rgba(127,140,160,.09),rgba(127,140,160,.04));backdrop-filter:blur(8px)}
.oa-dock-error{color:#e5484d;font-size:12px}
.oa-dock-button{display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa3b2);cursor:pointer;font-size:12px;line-height:18px;padding:2px 4px;border-radius:999px;transition:background .12s ease}
.oa-dock-button:hover{background:var(--dsw-alias-fill-l2,rgba(127,140,160,.12));color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-dock-name{font-weight:600;color:var(--dsw-alias-label-primary,#e6eaf2);letter-spacing:.2px}
.oa-dock-sep{width:1px;height:12px;background:var(--dsw-alias-border-l2,rgba(127,140,160,.25))}
.oa-dock-chip{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#c1c9d6);font-variant-numeric:tabular-nums}
.oa-dock-warn{color:#f5b04d}
.oa-chip-glyph{color:var(--dsw-alias-label-tertiary,#9aa3b2);font-size:11px}
.oa-dock-chevron{font-size:9px;transition:transform .15s ease}
.oa-dock-chevron-open{transform:rotate(180deg)}
.oa-panel{position:fixed;top:60px;right:14px;z-index:1000;width:min(600px,calc(100vw - 28px));max-height:calc(100vh - 88px);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));background:var(--dsw-specific-menu,#1a1f2b);box-shadow:0 16px 48px rgba(0,0,0,.45);border-radius:14px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;pointer-events:auto;animation:oa-fade .16s ease;scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l2,rgba(127,140,160,.45))) transparent}
.oa-panel::-webkit-scrollbar{width:10px}
.oa-panel::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l2,rgba(127,140,160,.45)));border-radius:5px}
.oa-panel::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,var(--dsw-alias-scrollbar-hover-l2,rgba(127,140,160,.65)))}
@keyframes oa-fade{from{opacity:0}to{opacity:1}}
.oa-panel-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));border-radius:14px 14px 0 0;background:var(--dsw-specific-menu,#1a1f2b)}
.oa-panel-title{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6eaf2)}
.oa-panel-actions{display:flex;gap:6px}
.oa-panel-button{border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));background:transparent;color:var(--dsw-alias-label-secondary,#c1c9d6);border-radius:8px;font-size:12px;line-height:18px;padding:3px 10px;cursor:pointer;transition:background .12s ease,color .12s ease}
.oa-panel-button:hover{background:var(--dsw-alias-fill-l2,rgba(127,140,160,.12));color:var(--dsw-alias-label-primary,#e6eaf2)}
.oa-panel-body{padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px}
.oa-panel-note{color:var(--dsw-alias-label-tertiary,#9aa3b2);font-size:12px;padding:8px 0}
.oa-panel-footer{position:sticky;bottom:0;z-index:1;display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary,#9aa3b2);font-size:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));padding-top:8px;padding-bottom:4px;background:var(--dsw-specific-menu,#1a1f2b)}
.oa-sec{border:1px solid rgba(127,140,160,.18);border-radius:10px;background:rgba(127,140,160,.04);overflow:hidden}
.oa-sec>summary{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c1c9d6);cursor:pointer;list-style:none;user-select:none}
.oa-sec>summary::-webkit-details-marker{display:none}
.oa-sec>summary::before{content:"▸";color:var(--dsw-alias-label-tertiary,#9aa3b2);font-size:10px;transition:transform .15s ease}
.oa-sec[open]>summary::before{transform:rotate(90deg)}
.oa-sec-body{padding:0 12px 10px;display:flex;flex-direction:column;gap:6px}
.oa-sec-hint{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#9aa3b2);margin-bottom:2px}
.oa-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.oa-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid rgba(127,140,160,.14);border-radius:8px;background:linear-gradient(160deg,rgba(91,157,255,.07),transparent)}
.oa-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa3b2);letter-spacing:.4px}
.oa-stat-value{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6eaf2);font-variant-numeric:tabular-nums}
.oa-stat-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-meter-row{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-meter{flex:1;height:8px;accent-color:var(--dsw-alias-text-info,#5b9dff)}
.oa-meter-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-metric{display:flex;flex-direction:column;gap:3px}
.oa-metric-head{display:flex;justify-content:space-between;font-size:11px;line-height:16px}
.oa-metric-label{color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-metric-values{display:flex;gap:8px;font-variant-numeric:tabular-nums}
.oa-metric-cur{color:var(--dsw-alias-label-primary,#e6eaf2);font-weight:600}
.oa-metric-gate{color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-track{position:relative;height:10px;background:var(--dsw-alias-fill-l2,rgba(127,140,160,.12));border-radius:6px;overflow:hidden}
.oa-track-fill{position:absolute;inset-block:0;left:0;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-text-info,#5b9dff),var(--dsw-alias-text-success,#46a758));box-shadow:0 0 8px rgba(91,157,255,.35)}
.oa-track-gate{position:absolute;top:-1px;bottom:-1px;width:2px;background:var(--dsw-alias-text-warning,#ffb224);border-radius:1px;opacity:.9}
.oa-top-head,.oa-top-row{display:grid;grid-template-columns:22px minmax(0,1fr) 46px 40px 36px 40px 46px 46px;gap:5px;align-items:center;font-size:11px;line-height:16px;padding:2px 4px}
.oa-top-head{color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-top-row{border-radius:6px;transition:background .1s ease}
.oa-top-row:hover{background:rgba(127,140,160,.07)}
.oa-rank{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.25));border-radius:50%;font-size:9px;font-weight:700;color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-rank-1{background:#f6c453;border-color:#f6c453;color:#1a1f2b}
.oa-rank-2{background:#b8c2d4;border-color:#b8c2d4;color:#1a1f2b}
.oa-rank-3{background:#d8a06a;border-color:#d8a06a;color:#1a1f2b}
.oa-top-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-top-cell{display:flex;flex-direction:column;gap:2px}
.oa-top-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-mini{display:block;height:3px;background:rgba(127,140,160,.15);border-radius:2px;overflow:hidden}
.oa-mini-fill{display:block;height:100%;background:linear-gradient(90deg,#5b9dff,#46a758);border-radius:2px}
.oa-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.oa-spark-wrap{position:relative;width:100%}
.oa-spark{width:100%;height:44px;display:block;cursor:crosshair}
.oa-spark-line{fill:none;stroke:#5b9dff;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.oa-spark-guide{stroke:var(--dsw-alias-border-l2,rgba(127,140,160,.5));stroke-width:1;vector-effect:non-scaling-stroke}
.oa-spark-dot{fill:#5b9dff;stroke:var(--dsw-specific-menu,#1a1f2b);stroke-width:1.5;vector-effect:non-scaling-stroke}
.oa-spark-tip{position:fixed;transform:translate(-50%,0);z-index:2000;pointer-events:none;background:var(--dsw-specific-menu,#1a1f2b);border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.3));border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.4);padding:6px 10px;display:flex;flex-direction:column;gap:2px;max-width:280px;width:max-content}
.oa-spark-tip-date{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary,#e6eaf2);font-variant-numeric:tabular-nums}
.oa-spark-tip-file{font-size:10px;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-spark-tip-det{font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa3b2);font-variant-numeric:tabular-nums}
.oa-hist-row{display:flex;flex-direction:column;gap:2px}
.oa-hist-head{display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:16px}
.oa-hist-date{color:var(--dsw-alias-label-tertiary,#9aa3b2);flex:none;font-variant-numeric:tabular-nums}
.oa-hist-file{color:var(--dsw-alias-label-secondary,#c1c9d6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.oa-hist-value{color:var(--dsw-alias-label-primary,#e6eaf2);flex:none;font-variant-numeric:tabular-nums}
.oa-hist-track{height:4px;background:var(--dsw-alias-fill-l2,rgba(127,140,160,.12));border-radius:2px;overflow:hidden}
.oa-hist-fill{height:100%;background:linear-gradient(90deg,rgba(91,157,255,.55),#5b9dff);border-radius:2px}
.oa-hist-chips{display:flex;gap:6px}
.oa-chip{display:inline-flex;align-items:center;padding:0 6px;border-radius:5px;font-size:10px;line-height:16px}
.oa-chip-det{background:rgba(229,72,77,.12);color:#ff8a8d}
.oa-chip-imp{background:rgba(70,167,88,.12);color:#6fce85}
.oa-chip-scale{background:rgba(91,157,255,.14);color:#8fb8ff}
.oa-caution{display:flex;gap:6px;align-items:center;padding:6px 8px;border:1px dashed rgba(255,178,36,.4);border-radius:8px;background:rgba(255,178,36,.06);font-size:10px;line-height:14px;color:#ffb224}
.oa-contract-line{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#9aa3b2);font-variant-numeric:tabular-nums}
.oa-policy{display:flex;flex-direction:column;gap:6px;padding:6px 0;border-bottom:1px dashed rgba(127,140,160,.18)}
.oa-tg{display:flex;flex-direction:column;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-tg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.oa-verdict{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-weight:600;font-size:10px;line-height:16px}
.oa-verdict-pass{background:rgba(46,160,67,.16);color:#57ab5a}
.oa-verdict-warn{background:rgba(255,178,36,.16);color:#ffb224}
.oa-verdict-block{background:rgba(229,72,77,.16);color:#e5484d}
.oa-tg-rows{display:flex;flex-direction:column;gap:2px}
.oa-tg-row{display:grid;grid-template-columns:minmax(0,1.2fr) 72px 44px 56px 44px 44px;gap:8px;align-items:baseline}
.oa-tg-row-head{color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-tg-num{text-align:right;font-variant-numeric:tabular-nums}
.oa-tg-note{color:var(--dsw-alias-label-tertiary,#9aa3b2)}
.oa-tg-error{color:#e5484d}
.oa-policy:last-child{border-bottom:none}
.oa-policy-title{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary,#c1c9d6);letter-spacing:.3px}
.oa-dist{display:flex;flex-direction:column;gap:4px}
.oa-dist-bars{display:flex;align-items:flex-end;gap:2px;height:64px}
.oa-dist-bar{flex:1;position:relative;overflow:visible;background:linear-gradient(180deg,rgba(91,157,255,.9),rgba(91,157,255,.35));border-radius:3px 3px 1px 1px;min-height:4px;transition:filter .12s ease}
.oa-dist-bar:hover{filter:brightness(1.25)}
.oa-dist-tip{position:fixed;transform:translate(-50%,-100%);z-index:2000;pointer-events:none;background:var(--dsw-specific-menu,#1a1f2b);border:1px solid var(--dsw-alias-border-l2,rgba(127,140,160,.3));border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.4);padding:4px 8px;font-size:10px;line-height:15px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#c1c9d6)}
.oa-dist-scale{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa3b2);font-variant-numeric:tabular-nums}
.oa-dist-mean{color:var(--dsw-alias-label-secondary,#c1c9d6)}
`;

export function apply(ctx, config = {}) {
  const slots = ctx?.slots ?? ctx?.get?.("slots");
  if (!slots || typeof slots.inject !== "function") return;
  const refreshMs = typeof config?.refreshMs === "number" ? config.refreshMs : 20_000;

  // 动态包内置 styles；静态打包缺失时跳过（样式可随打包器的 CSS 管线注入）。
  if (typeof styles !== "undefined" && styles !== null && typeof styles.insert === "function") {
    styles.insert(CSS);
  }

  const hub = createStoreHub(ctx, refreshMs);

  slots.inject("conversation.composer.dock", () => slots.register(
    { name: "conversation.composer.dock", id: "openarch-governance", order: 2, label: () => "OpenArch" },
    (props) => React.createElement(GovernanceDock, { hub, props }),
  ));

  slots.inject("shell.overlay", () => slots.register(
    { name: "shell.overlay", id: "openarch-dashboard", order: 60 },
    () => React.createElement(GovernancePanel, { hub }),
  ));
}

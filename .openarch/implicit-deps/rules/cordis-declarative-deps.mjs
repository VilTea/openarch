// Cordis declarative dependency dogfood rule（项目级实验，2026-08-15）。
//
// Cordis 插件通过字符串键声明依赖（inject/ctx.get/harness.handle/host.call/
// web(Server).register/fetch/slots.inject），provider 与 consumer 常分布在不同
// 文件且无静态 import。本规则使用引擎内置 AST 事实 string-key-calls.v1：
// 引号/三元 URL/局部字符串变量由引擎解析，脚本只负责键语义配对。
//
// 找不到项目内 provider 的键以 observations 报告（report-only），不伪造端点；
// 动态键（ctx.get(key)）保留为 dynamic_key 观测。
const SERVICE_PROVIDERS = new Set(["ctx.provide", "ctx.set"]);
const SERVICE_CONSUMERS = new Set(["ctx.get"]);
const RPC_PROVIDERS = new Set(["harness.handle"]);
const RPC_CONSUMERS = new Set(["host.call", "rpc.call"]);
const HTTP_PROVIDERS = new Set(["web.register", "webServer.register"]);
const HTTP_CONSUMERS = new Set(["fetch"]);

const normalizeHttpPath = (path) => {
  const trimmed = typeof path === "string" ? path.replace(/[?#].*$/, "").replace(/\/+$/, "") : path;
  return trimmed && trimmed.startsWith("/") ? trimmed : null;
};

export default {
  targets: { include: ["packages/openarch-plugin/dsh/**"], languages: ["javascript", "typescript"] },
  stages: {
    text: ({ files, allFiles, text }) => {
      // 消费者模式：需要全量候选做 provider↔consumer 键相关（变更模式也如此）。
      const pool = allFiles && allFiles.length > 0 ? allFiles : files;
      return pool.filter((file) => {
        const source = text(file);
        return /inject\s*[:=]|ctx\.(?:get|provide|set)\(|harness\.handle\(|host\.call\(|rpc\.call\(|fetch\(|web(?:Server)?\.register\(|slots\.inject\(/.test(source);
      });
    },
    ast: { fact: "string-key-calls-ts-js.v1" },
  },
  link({ records, log }) {
    const rpcProviders = new Map();
    const httpProviders = new Map();
    const serviceProviders = new Map();
    const locals = new Map();
    const consumers = [];
    const unresolved = new Map();
    let dynamicCalls = 0;

    for (const record of records) {
      if (record.kind === "array" && record.name === "inject") {
        consumers.push({ file: record._file, kind: "service", key: record.key });
        continue;
      }
      if (record.kind === "local") {
        const byFile = locals.get(record._file) ?? new Map();
        byFile.set(record.name, record.value);
        locals.set(record._file, byFile);
        continue;
      }
      if (record.kind === "dynamicCall" && SERVICE_CONSUMERS.has(record.op)) {
        dynamicCalls += 1;
        continue;
      }
      if (record.kind === "callArg" && HTTP_CONSUMERS.has(record.op)) {
        consumers.push({ file: record._file, kind: "http", arg: record.arg });
        continue;
      }
      if (record.kind !== "call") continue;
      if (RPC_PROVIDERS.has(record.op)) rpcProviders.set(record.key, record._file);
      if (HTTP_PROVIDERS.has(record.op) && record.pkey === "path") {
        const path = normalizeHttpPath(record.key);
        if (path) httpProviders.set(path, record._file);
      }
      if (SERVICE_PROVIDERS.has(record.op)) serviceProviders.set(record.key, record._file);
      if (RPC_CONSUMERS.has(record.op)) consumers.push({ file: record._file, kind: "rpc", key: record.key });
      if (HTTP_CONSUMERS.has(record.op) && record.key) consumers.push({ file: record._file, kind: "http", key: record.key });
      if (SERVICE_CONSUMERS.has(record.op)) consumers.push({ file: record._file, kind: "service", key: record.key });
    }

    const edges = [];
    for (const consumer of consumers) {
      let provider = null;
      let via = null;
      if (consumer.kind === "rpc") {
        provider = rpcProviders.get(consumer.key);
        via = `cordis:rpc:${consumer.key}`;
      } else if (consumer.kind === "http") {
        const path = consumer.key ? normalizeHttpPath(consumer.key)
          : normalizeHttpPath(locals.get(consumer.file)?.get(consumer.arg));
        provider = path ? httpProviders.get(path) : null;
        via = path ? `cordis:http:${path}` : null;
      } else if (consumer.kind === "service") {
        provider = serviceProviders.get(consumer.key);
        via = `cordis:service:${consumer.key}`;
      }
      if (provider && via && provider !== consumer.file) {
        edges.push({ from: consumer.file, to: provider, via, type: "cordis_declarative" });
      } else if (via && !provider) {
        const files = unresolved.get(via) ?? [];
        files.push(consumer.file);
        unresolved.set(via, files);
      }
    }

    const observations = [
      ...dynamicCalls > 0
        ? [{ kind: "dynamic_key", via: "ctx.get", files: ["packages/openarch-plugin/dsh"], message: `${dynamicCalls} 个动态服务键（变量键），静态不猜测` }]
        : [],
      ...[...unresolved.entries()].map(([key, files]) => ({
        kind: "unresolved_key", via: key, files, message: "项目内无 provider；多为 DSH runtime 服务",
      })),
    ];

    log(`cordis-declarative-deps: ${records.length} records → ${edges.length} edges; unresolved keys=${unresolved.size}; dynamic ctx.get=${dynamicCalls}`);
    return { edges, observations };
  },
};

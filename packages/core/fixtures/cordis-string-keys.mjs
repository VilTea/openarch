// Fixture for string-key-calls.v1: declarative string-key syntax.
export const inject = ["tools", "timer"];

const url = true ? "/api/openarch/governance-state" : "/api/openarch/governance-state?force=1";

export function apply(ctx) {
  const web = ctx.get("webServer");
  web.register({ kind: "exact", path: "/api/openarch/governance-state" });
  ctx.get(dynamicKey);
  harness.handle("openarch/governance-state", () => {});
  host.call("openarch/governance-state");
  fetch(url);
}

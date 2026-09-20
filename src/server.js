import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { buildApp, buildStoreFromContext } from "./http.js";

export { buildApp, buildStoreFromContext };

/** 同步构建完整服务（健康检查与全部业务接口共用一个 store 实例）。 */
export function buildServer(options = {}) {
  const contextPath =
    options.contextPath ?? new URL("../fixtures/context.json", import.meta.url);
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const store = buildStoreFromContext(context, {
    journalPath: options.journalPath ?? process.env.AUDIT_PATH ?? "data/audit-log.jsonl",
  });
  return createServer(buildApp(store, options));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = buildServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`[connection-decision] listening on :${port}`);
  });
}

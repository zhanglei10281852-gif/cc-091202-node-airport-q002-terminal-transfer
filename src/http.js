// HTTP 适配层。两类调用方：
// - 主管（X-Supervisor-Token）：可见全部旅客、分段归因、锁定状态、波次排序；
// - 旅客（按 passengerId 自取）：响应里只有本人的脱敏信息，
//   不含任何同组旅客或他人行程字段。
// 运行事件推送方同样使用主管令牌。

import { Store } from "./domain/store.js";
import { RuleCatalog } from "./domain/rules.js";

export function buildApp(store, { supervisorToken = process.env.SUPERVISOR_TOKEN ?? "dev-supervisor-token" } = {}) {
  async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("invalid_json");
    }
  }

  function send(response, status, body) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  const supervisorAuthorized = (request) =>
    request.headers["x-supervisor-token"] === supervisorToken;

  /**
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   */
  return async function app(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }

      // ---- 旅客侧：无需主管令牌，且只能查本人，响应不含他人数据 ----
      const passengerMatch = url.pathname.match(/^\/api\/passengers\/([^/]+)$/);
      if (request.method === "GET" && passengerMatch) {
        const view = store.passengerView(decodeURIComponent(passengerMatch[1]));
        if (!view) {
          send(response, 404, { error: "not_found" });
          return;
        }
        send(response, 200, view);
        return;
      }

      // ---- 以下全部为主管侧 ----
      if (!supervisorAuthorized(request)) {
        send(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        const body = await readJson(request);
        const events = Array.isArray(body) ? body : body.events ?? [body];
        const results = events.map((event) => store.ingestEvent(event));
        const duplicated = results.every((r) => r.duplicated);
        // 重复推送是正常的上游重试：返回 200 而非新建处置
        send(response, duplicated ? 200 : 202, { ingested: results });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/journeys") {
        send(response, 200, { journeyIds: store.listJourneys().map((j) => j.journeyId) });
        return;
      }

      const journeyMatch = url.pathname.match(/^\/api\/journeys\/([^/]+)$/);
      if (request.method === "GET" && journeyMatch) {
        const id = decodeURIComponent(journeyMatch[1]);
        if (!store.getJourney(id)) {
          send(response, 404, { error: "unknown_journey" });
          return;
        }
        send(response, 200, store.supervisorView(id));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/decisions/confirm") {
        const body = await readJson(request);
        const outcome = store.confirm({
          journeyId: body.journeyId,
          groupId: body.groupId,
          passengerIds: body.passengerIds,
          decision: body.decision,
          note: body.note,
          idempotencyKey: body.idempotencyKey,
        });
        send(response, 200, { confirmed: outcome });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reevaluate") {
        const body = await readJson(request);
        store.reevaluate(body.journeyId, "manual");
        send(response, 200, { reevaluated: body.journeyId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/waves") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) {
          send(response, 400, { error: "require_from_and_to" });
          return;
        }
        send(response, 200, store.wavePriority(from, to));
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      const status = /^invalid|^no_|^unknown/.test(message) ? 400 : 500;
      send(response, status, { error: message });
    }
  };
}

/** 从资料包构建默认服务（server.js 启动与测试共用）。 */
export function buildStoreFromContext(context, { journalPath = null } = {}) {
  const catalog = new RuleCatalog(context.rules, context.riskWindowMinutes ?? 20);
  const journeys = Object.fromEntries(context.records.map((r) => [r.journeyId, r]));
  return new Store({ ruleCatalog: catalog, journeys, journalPath });
}

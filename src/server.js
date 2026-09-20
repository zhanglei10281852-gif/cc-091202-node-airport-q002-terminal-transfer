import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonStore } from "./store.js";
import { DecisionService } from "./service.js";

/**
 * 组装服务依赖。contextPath 指向资料包 JSON，dataPath 指向持久化状态文件。
 * 角色鉴权为最小实现：通过 x-role 头区分 supervisor / counter / passenger / upstream，
 * 生产部署应替换为网关签发的身份凭证。
 */
export async function createApp({
  contextPath = new URL("../fixtures/context.json", import.meta.url),
  dataPath = process.env.DATA_PATH
    ? pathToFileURL(process.env.DATA_PATH)
    : new URL("../data/state.json", import.meta.url),
  riskWindowMinutes,
  now,
} = {}) {
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const store = await JsonStore.open(fileURLToPath(dataPath));
  const service = new DecisionService(store, context, { riskWindowMinutes, now });

  return buildServer(service, store);
}

export function buildServer(service, store) {
  return createServer(async (request, response) => {
    try {
      await route(request, response, service, store);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, { error: status >= 500 ? "internal_error" : error.message });
    }
  });
}

async function route(request, response, service, store) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ok", contextVersion: service.indexed.contextVersion });
    return;
  }

  // 上游运行事件：幂等接收
  if (request.method === "POST" && pathname === "/events") {
    requireRole(request, ["upstream", "supervisor"]);
    const body = await readJson(request);
    const result = service.ingestEvent(body);
    await store.persist();
    sendJson(response, result.duplicate ? 200 : 202, result);
    return;
  }

  // 旅客/同行组登记
  if (request.method === "POST" && pathname === "/passengers") {
    requireRole(request, ["supervisor"]);
    const body = await readJson(request);
    const advice = service.registerPassengers(body.passengers ?? body);
    await store.persist();
    sendJson(response, 201, { advice: advice.map((a) => service.supervisorView(a)) });
    return;
  }

  // 主管：建议列表（可按波次过滤）
  if (request.method === "GET" && pathname === "/advice") {
    requireRole(request, ["supervisor"]);
    const waveId = url.searchParams.get("waveId");
    sendJson(response, 200, { advice: service.listSupervisorAdvice(waveId ? { waveId } : {}) });
    return;
  }

  const decisionMatch = pathname.match(/^\/advice\/([^/]+)\/decision$/);
  if (request.method === "POST" && decisionMatch) {
    requireRole(request, ["counter", "supervisor"]);
    const body = await readJson(request);
    const advice = service.applyCounterDecision(decisionMatch[1], body.action, body.by ?? request.headers["x-staff-id"]);
    await store.persist();
    sendJson(response, 200, service.supervisorView(advice));
    return;
  }

  const adviceMatch = pathname.match(/^\/advice\/([^/]+)$/);
  if (request.method === "GET" && adviceMatch) {
    requireRole(request, ["supervisor", "counter"]);
    const advice = service.store.getAdvice(adviceMatch[1]);
    if (!advice) throw notFound();
    sendJson(response, 200, service.supervisorView(advice));
    return;
  }

  // 主管：某到达波次处置优先级
  const waveMatch = pathname.match(/^\/waves\/([^/]+)\/priority$/);
  if (request.method === "GET" && waveMatch) {
    requireRole(request, ["supervisor", "counter"]);
    sendJson(response, 200, { priority: service.wavePriority(waveMatch[1]) });
    return;
  }

  // 旅客自助：只看得到自己那一条
  if (request.method === "GET" && pathname === "/me/advice") {
    requireRole(request, ["passenger"]);
    const passengerId = request.headers["x-passenger-id"];
    if (!passengerId) throw httpError(401, "missing_passenger_identity");
    sendJson(response, 200, service.passengerView(passengerId));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function requireRole(request, allowed) {
  const role = request.headers["x-role"] ?? "passenger";
  if (!allowed.includes(role)) throw httpError(403, "forbidden_role");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  return error;
}
function notFound() {
  return httpError(404, "advice_not_found");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  createApp()
    .then((server) => server.listen(port, "0.0.0.0"))
    .then(() => console.log(`decision service listening on ${port}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

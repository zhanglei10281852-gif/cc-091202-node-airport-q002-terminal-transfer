import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { JsonStore } from "../src/store.js";
import { DecisionService } from "../src/service.js";
import contextJson from "../fixtures/context.json" with { type: "json" };

async function start(context) {
  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), "mct-http-")), "state.json"));
  const service = new DecisionService(store, context);
  const server = buildServer(service, store).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store };
}

test("端到端：登记 → 事件 → 主管排序 → 柜台冻结；旅客与主管视图相互隔离", async (t) => {
  const { server, base } = await start(contextJson);
  t.after(() => server.close());

  const resRegister = await fetch(`${base}/passengers`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "supervisor" },
    body: JSON.stringify({
      passengers: [
        { passengerId: "u1", groupId: "g1", name: "王梅", journeyId: "cx-1001", waveId: "wave-A", flags: [] },
        { passengerId: "u2", groupId: "g1", name: "王婴儿", journeyId: "cx-1001", waveId: "wave-A", flags: ["INFANT"] },
        { passengerId: "u3", name: "陈晨", journeyId: "cx-1002", waveId: "wave-A", flags: ["TRANSIT_VISA_CHECK"] },
      ],
    }),
  });
  assert.equal(resRegister.status, 201);
  const registered = await resRegister.json();
  assert.equal(registered.advice.length, 2);
  const family = registered.advice.find((a) => a.kind === "GROUP");
  assert.equal(family.members.find((m) => m.passengerId === "u2").name, "王婴儿");

  // 重复事件：第一次 202，第二次仍 200 且无重算
  const event = { eventId: "http-evt-1", journeyId: "cx-1001", type: "ARRIVAL", actualTime: "2026-09-12T23:20:00+08:00" };
  const r1 = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "upstream" },
    body: JSON.stringify(event),
  });
  assert.equal(r1.status, 202);
  const r2 = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "upstream" },
    body: JSON.stringify(event),
  });
  assert.equal(r2.status, 200);
  assert.deepEqual((await r2.json()).recomputed, []);

  // 波次优先级：失接/风险在前
  const resWave = await fetch(`${base}/waves/wave-A/priority`, { headers: { "x-role": "supervisor" } });
  const { priority } = await resWave.json();
  assert.ok(priority[0].status !== "OK");
  assert.ok(priority[0].riskContributors.length > 0);

  // 柜台冻结
  const resDecision = await fetch(`${base}/advice/${family.adviceId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "counter", "x-staff-id": "c-9" },
    body: JSON.stringify({ action: "RETAIN" }),
  });
  assert.equal(resDecision.status, 200);
  assert.equal((await resDecision.json()).counterAction.action, "RETAIN");

  // 旅客视图：看不到他人身份
  const resMe = await fetch(`${base}/me/advice`, { headers: { "x-role": "passenger", "x-passenger-id": "u1" } });
  const me = await resMe.json();
  assert.equal(me.groupSize, 2);
  assert.deepEqual(me.fellowTravelers, [{ seat: "同行旅客1" }]);
  assert.ok(!("name" in me));

  // 旅客无权调主管接口
  const forbidden = await fetch(`${base}/advice`, { headers: { "x-role": "passenger" } });
  assert.equal(forbidden.status, 403);
});

test("健康接口返回资料版本", async (t) => {
  const { server, base } = await start(contextJson);
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.contextVersion, "ctx-2026-09-pack-1");
});

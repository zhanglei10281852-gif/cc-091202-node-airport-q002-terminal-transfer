import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store.js";
import { DecisionService } from "../src/service.js";
import { STATUS } from "../src/domain.js";

const context = JSON.parse(
  await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"),
);

function makeService() {
  const store = new JsonStore(null);
  return { store, service: new DecisionService(store, context) };
}

const FAMILY = [
  { passengerId: "p-mom", groupId: "g1", name: "王梅", journeyId: "cx-1001", waveId: "w-2250", flags: [] },
  { passengerId: "p-dad", groupId: "g1", name: "王强", journeyId: "cx-1001", waveId: "w-2250", flags: [] },
  { passengerId: "p-baby", groupId: "g1", name: "王婴儿", journeyId: "cx-1001", waveId: "w-2250", flags: ["INFANT"] },
];

test("登记同行组生成一条组建议，婴儿缓冲使其成为控制性成员", () => {
  const { service } = makeService();
  const [advice] = service.registerPassengers(FAMILY);
  assert.equal(advice.kind, "GROUP");
  assert.equal(advice.passengerIds.length, 3);
  assert.equal(advice.governingPassengerId, "p-baby");
  // 105 - (45+20+10) = 30 分钟富余
  assert.equal(advice.slackMinutes, 30);
  assert.equal(advice.status, STATUS.OK);
  assert.equal(advice.versions.ruleVersion, "mct-2026-09");
  assert.equal(advice.versions.contextVersion, "ctx-2026-09-pack-1");
  assert.ok(advice.basis.arrivalEventId === null); // 初版依据计划时间
});

test("同一运行事件重复推送不产生第二份处置，且只刷新未确认建议", () => {
  const { service } = makeService();
  const [advice] = service.registerPassengers(FAMILY);
  const event = {
    eventId: "evt-1",
    journeyId: "cx-1001",
    type: "ARRIVAL",
    actualTime: "2026-09-12T23:20:00+08:00", // 延误 30 分钟
  };
  const first = service.ingestEvent(event);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.recomputed, [advice.adviceId]);
  // 105 - 30 = 75 可用；婴儿需 75 → 富余 0 → 风险
  assert.equal(service.store.getAdvice(advice.adviceId).status, STATUS.RISK);

  const second = service.ingestEvent(event);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.recomputed, []);
  assert.equal(service.store.hasEvent("evt-1"), true);
});

test("柜台已执行的改签决定不会被后续更糟的事件重算覆盖", () => {
  const { service } = makeService();
  const [advice] = service.registerPassengers(FAMILY);
  service.ingestEvent({
    eventId: "evt-a",
    journeyId: "cx-1001",
    type: "ARRIVAL",
    actualTime: "2026-09-12T23:10:00+08:00",
  });
  const before = service.store.getAdvice(advice.adviceId);
  assert.equal(before.status, STATUS.RISK);

  service.applyCounterDecision(advice.adviceId, "REBOOK", "counter-03");
  assert.equal(before.decisionState, "CONFIRMED");
  assert.equal(before.counterAction.action, "REBOOK");

  // 即使彻底失接，已确认建议保持柜台结论
  const afterEvent = service.ingestEvent({
    eventId: "evt-b",
    journeyId: "cx-1001",
    type: "ARRIVAL",
    actualTime: "2026-09-13T00:30:00+08:00",
  });
  assert.deepEqual(afterEvent.recomputed, []);
  const frozen = service.store.getAdvice(advice.adviceId);
  assert.equal(frozen.status, STATUS.RISK);
  assert.equal(frozen.counterAction.action, "REBOOK");
  // 不允许重复确认
  assert.throws(
    () => service.applyCounterDecision(advice.adviceId, "ABANDON"),
    /advice_already_confirmed/,
  );
});

test("上游时间反复变化时未确认建议持续更新，history 留下版本轨迹", () => {
  const { service } = makeService();
  const [advice] = service.registerPassengers([
    { passengerId: "solo", name: "李明", journeyId: "cx-1002", waveId: "w-2340", flags: ["WHEELCHAIR"] },
  ]);
  service.ingestEvent({ eventId: "e1", journeyId: "cx-1002", type: "ARRIVAL", actualTime: "2026-09-12T23:50:00+08:00" });
  service.ingestEvent({ eventId: "e2", journeyId: "cx-1002", type: "ARRIVAL", actualTime: "2026-09-13T00:05:00+08:00" });
  service.ingestEvent({ eventId: "e3", journeyId: "cx-1002", type: "DEPARTURE", actualTime: "2026-09-13T01:30:00+08:00" });
  const latest = service.store.getAdvice(advice.adviceId);
  // 到 00:05、飞 01:30 → 85 分钟可用；轮椅需 40+15+20+20=95 → 失接
  assert.equal(latest.status, STATUS.MISSED);
  assert.equal(latest.basis.arrivalEventId, "e2");
  assert.equal(latest.basis.departureEventId, "e3");
  assert.ok(latest.history.length >= 3);
  assert.equal(latest.history.at(-1).ruleVersion, "mct-2026-09");
});

test("波次优先级列出最该先处理的人；主管视图解释风险来自哪一段", () => {
  const { service } = makeService();
  service.registerPassengers(FAMILY);
  service.registerPassengers([
    { passengerId: "visa-p", name: "陈晨", journeyId: "cx-1002", waveId: "w-2250", flags: ["TRANSIT_VISA_CHECK"] },
  ]);
  // cx-1001 家庭被延误到风险
  service.ingestEvent({ eventId: "ev-x", journeyId: "cx-1001", type: "ARRIVAL", actualTime: "2026-09-12T23:20:00+08:00" });

  const priority = service.wavePriority("w-2250");
  assert.equal(priority[0].status, STATUS.RISK);
  assert.equal(priority[0].journey.arrivalFlight, "CA1832");
  // 主管视图带分段耗时与边检/缓冲信息
  const topKeys = priority[0].riskContributors.map((c) => c.key);
  assert.ok(topKeys.includes("TRANSFER_BUS"));
  assert.ok(topKeys.includes("BUFFER:INFANT"));
});

test("旅客视图对本人隐藏同行者身份与他人行程，也查不到别人的建议", () => {
  const { service } = makeService();
  service.registerPassengers(FAMILY);
  const view = service.passengerView("p-mom");
  assert.equal(view.groupSize, 3);
  assert.deepEqual(view.fellowTravelers, [{ seat: "同行旅客1" }, { seat: "同行旅客2" }]);
  assert.equal(view.status, STATUS.OK);
  assert.ok(!("members" in view));
  assert.ok(!("journey" in view));
  assert.throws(() => service.passengerView("unknown"), /advice_not_found/);
});

test("同组旅客分两次登记只保留一条组建议；已冻结的组拒绝再加入成员", () => {
  const { service } = makeService();
  const [first] = service.registerPassengers([FAMILY[0], FAMILY[1]]);
  assert.equal(first.passengerIds.length, 2);

  const [again] = service.registerPassengers([FAMILY[2]]);
  assert.equal(again.adviceId, first.adviceId);
  assert.deepEqual(
    again.passengerIds.toSorted(),
    ["p-baby", "p-dad", "p-mom"],
  );
  assert.equal(service.store.listAdvice().length, 1);

  service.applyCounterDecision(first.adviceId, "RETAIN");
  assert.throws(
    () =>
      service.registerPassengers([
        { passengerId: "p-late", groupId: "g1", name: "后来者", journeyId: "cx-1001", flags: [] },
      ]),
    /group_advice_locked/,
  );
});

test("判定所依据的规则与资料版本随状态持久化，重启后仍可查询", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "mct-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");

  const store1 = await JsonStore.open(file);
  const service1 = new DecisionService(store1, contextFixture());
  service1.registerPassengers(FAMILY);
  service1.ingestEvent({
    eventId: "persist-1",
    journeyId: "cx-1001",
    type: "ARRIVAL",
    actualTime: "2026-09-12T23:20:00+08:00",
  });
  await store1.persist();

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.ok(raw.appliedEvents.includes("persist-1"));
  assert.equal(raw.advice[0].versions.ruleVersion, "mct-2026-09");

  const store2 = await JsonStore.open(file);
  const service2 = new DecisionService(store2, contextFixture());
  // 重放同一事件被识别为重复，不产生第二份处置
  const replay = service2.ingestEvent({
    eventId: "persist-1",
    journeyId: "cx-1001",
    type: "ARRIVAL",
    actualTime: "2026-09-12T23:20:00+08:00",
  });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.recomputed, []);
  assert.equal(store2.listAdvice()[0].status, STATUS.RISK);
});

function contextFixture() {
  return JSON.parse(JSON.stringify(context));
}

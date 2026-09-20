import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  indexContext,
  effectiveRuleAt,
  parseTime,
  evaluatePassenger,
  evaluateGroup,
  priorityRank,
  STATUS,
} from "../src/domain.js";

const context = JSON.parse(
  await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"),
);
const indexed = indexContext(context);

function journeyTimes(journeyId) {
  const journey = indexed.journeys.get(journeyId);
  return {
    journey,
    arrivalMs: parseTime(journey.arrival.time),
    departureMs: parseTime(journey.departure.time),
  };
}

function evalOn(journeyId, flags = [], arrivalOverrideMs) {
  const { journey, arrivalMs, departureMs } = journeyTimes(journeyId);
  const rule = effectiveRuleAt(
    indexed.mctRules,
    journey.arrival.terminal,
    journey.departure.terminal,
    arrivalMs,
  );
  const transferTime = indexed.transferTimes.get(
    `${journey.arrival.terminal}->${journey.departure.terminal}`,
  );
  return evaluatePassenger({
    passenger: { passengerId: "t", flags },
    journey,
    transferTime,
    rule,
    arrivalMs: arrivalOverrideMs ?? arrivalMs,
    departureMs,
  });
}

test("跨午夜的 cx-1001：22:50 到 00:35 可用 105 分钟，轮椅缓冲 20 分钟后判为风险", () => {
  const result = evalOn("cx-1001", ["WHEELCHAIR"]);
  assert.equal(result.availableMinutes, 105);
  assert.equal(result.requiredMctMinutes, 85); // 45 基础 + 20 安检 + 20 轮椅
  assert.equal(result.slackMinutes, 20);
  assert.equal(result.status, STATUS.RISK);
  assert.equal(result.ruleVersion, "mct-2026-09");
  // 风险来源按耗时排序，摆渡车是最大的一段
  assert.equal(result.riskContributors[0].key, "TRANSFER_BUS");
});

test("cx-1002 普通旅客富余 25 分钟可衔接；带过境检查缓冲后进入风险", () => {
  const normal = evalOn("cx-1002", []);
  assert.equal(normal.requiredMctMinutes, 75); // 40 + 15 安检 + 20 边检
  assert.equal(normal.status, STATUS.OK);

  const visa = evalOn("cx-1002", ["TRANSIT_VISA_CHECK"]);
  assert.equal(visa.requiredMctMinutes, 90);
  assert.equal(visa.slackMinutes, 10);
  assert.equal(visa.status, STATUS.RISK);
  assert.ok(visa.riskContributors.some((c) => c.key === "BUFFER:TRANSIT_VISA_CHECK"));
});

test("不同时区偏移量表示同一时刻，结论稳定一致", () => {
  const journey = indexed.journeys.get("cx-1001");
  const inShanghai = parseTime("2026-09-12T22:50:00+08:00");
  const inTokyo = parseTime("2026-09-12T23:50:00+09:00");
  const inUtc = parseTime("2026-09-12T14:50:00Z");
  assert.equal(inShanghai, inTokyo);
  assert.equal(inShanghai, inUtc);
  assert.notEqual(
    parseTime(journey.departure.time) - inShanghai,
    NaN,
  );
});

test("拒绝无时区偏移量的时间字符串", () => {
  assert.throws(() => parseTime("2026-09-12T22:50:00"), /invalid_time/);
});

test("规则按到达时刻生效换版：10 月 1 日起使用 mct-2026-10", () => {
  const september = effectiveRuleAt(indexed.mctRules, "T2", "T3", parseTime("2026-09-30T23:59:00+08:00"));
  const october = effectiveRuleAt(indexed.mctRules, "T2", "T3", parseTime("2026-10-01T00:30:00+08:00"));
  assert.equal(september.ruleVersion, "mct-2026-09");
  assert.equal(october.ruleVersion, "mct-2026-10");
  assert.equal(october.baseMinutes, 50);
});

test("延误到可用时间为负即已失接", () => {
  const { departureMs } = journeyTimes("cx-1001");
  const result = evalOn("cx-1001", ["WHEELCHAIR"], departureMs - 30 * 60000);
  assert.equal(result.status, STATUS.MISSED);
  assert.ok(result.slackMinutes < 0);
});

test("同行组取要求最高的成员；波次优先级失接优先、同档按富余升序", () => {
  const adult = { passengerId: "a", slackMinutes: 10, status: STATUS.RISK };
  const infant = { passengerId: "i", slackMinutes: 15, status: STATUS.RISK };
  const group = evaluateGroup([adult, infant]);
  assert.equal(group.governingPassengerId, "a");
  assert.equal(group.status, STATUS.RISK);

  const ranked = priorityRank([
    { adviceId: "ok", status: STATUS.OK, slackMinutes: 25 },
    { adviceId: "miss", status: STATUS.MISSED, slackMinutes: -10 },
    { adviceId: "risk2", status: STATUS.RISK, slackMinutes: 20 },
    { adviceId: "risk1", status: STATUS.RISK, slackMinutes: 10 },
  ]);
  assert.deepEqual(ranked.map((r) => r.adviceId), ["miss", "risk1", "risk2", "ok"]);
});

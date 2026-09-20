import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { RuleCatalog } from "../src/domain/rules.js";
import { Store } from "../src/domain/store.js";
import { evaluateJourney } from "../src/domain/engine.js";
import { parseInstant } from "../src/domain/time.js";

const TOKEN = "test-token";

function tempJournal() {
  const dir = mkdtempSync(join(tmpdir(), "mct-"));
  return { dir, journal: join(dir, "audit.jsonl") };
}

async function startServer(journal, token = TOKEN) {
  const server = buildServer({ journalPath: journal, supervisorToken: token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    stop: () => server.close(),
  };
}

async function jsonHttp(base, pathname, { method = "GET", token = TOKEN, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-supervisor-token": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------
// 时间基础：跨午夜与不同偏移量
// ---------------------------------------------------------------------------

test("跨午夜的衔接按绝对时刻计算，不做墙上时钟相减", () => {
  const arrival = parseInstant("2026-09-12T22:50:00+08:00");
  const departure = parseInstant("2026-09-13T00:50:00+08:00");
  assert.equal(departure - arrival, 120 * 60_000);
});

test("不同时区偏移量的航班仍得到稳定的绝对间隔", () => {
  // 22:50+08:00 与 14:50Z 是同一时刻；00:50+08:00(+1d) 与 16:50Z 同一时刻
  assert.equal(
    parseInstant("2026-09-13T00:50:00+08:00") - parseInstant("2026-09-12T16:50:00Z"),
    0,
  );
  assert.equal(
    parseInstant("2026-09-12T22:50:00+08:00") - parseInstant("2026-09-12T20:20:00+05:30"),
    0,
  );
});

test("无时区后缀的时间被拒绝，避免按服务器时区静默解释", () => {
  assert.throws(() => parseInstant("2026-09-12 22:50:00"));
});

// ---------------------------------------------------------------------------
// 规则版本：当时生效
// ---------------------------------------------------------------------------

test("评估时刻决定命中的 MCT 版本", () => {
  const catalog = new RuleCatalog(
    [
      { ruleVersion: "v1", effectiveFrom: "2026-01-01T00:00:00+08:00", pairs: [] },
      { ruleVersion: "v2", effectiveFrom: "2026-10-01T00:00:00+08:00", pairs: [] },
    ],
    20,
  );
  assert.equal(catalog.versionAt(parseInstant("2026-09-20T12:00:00+08:00")).ruleVersion, "v1");
  assert.equal(catalog.versionAt(parseInstant("2026-10-02T12:00:00+08:00")).ruleVersion, "v2");
  assert.throws(() => catalog.versionAt(parseInstant("2025-12-31T00:00:00+08:00")));
});

// ---------------------------------------------------------------------------
// 引擎：分段耗时、个人缓冲、风险归因
// ---------------------------------------------------------------------------

function tinyContext() {
  const catalog = new RuleCatalog(
    [
      {
        ruleVersion: "mct-test",
        effectiveFrom: "2026-09-01T00:00:00+08:00",
        pairs: [
          { from: "T2", to: "T3", baseMinutes: 70, transferBusMinutes: 15, securityMinutes: 20 },
        ],
        buffers: { INFANT: 30, WHEELCHAIR: 25, TRANSIT_VISA_REQUIRED: 30 },
      },
    ],
    20,
  );
  const journey = {
    journeyId: "j1",
    arrival: { flight: "A1", terminal: "T2", scheduledTime: "2026-09-12T22:50:00+08:00" },
    departure: { flight: "B2", terminal: "T3", scheduledTime: "2026-09-13T00:50:00+08:00" },
    steps: ["DEBOARD", "TRANSFER_BUS", "SECURITY", "WALK"],
    passengerGroup: {
      groupId: "g1",
      passengers: [
        { passengerId: "adult", flags: [] },
        { passengerId: "wheel", flags: ["WHEELCHAIR"] },
        { passengerId: "infant", flags: ["INFANT"] },
        { passengerId: "visa", flags: ["TRANSIT_VISA_REQUIRED"] },
      ],
    },
  };
  return { catalog, journey };
}

test("同组旅客采用各自缓冲，结论可以不同", () => {
  const { catalog, journey } = tinyContext();
  // 计划：可用间隔 120 分钟；截载 00:35（-15）
  // 成人所需 70+15+20 = 105，余量 0 => RISK
  // 轮椅 130 / 婴儿 135 / 需过境签 135 => MISSED
  const result = evaluateJourney(journey, [], {
    ruleCatalog: catalog,
    atMs: parseInstant("2026-09-12T20:00:00+08:00"),
  });
  const byId = Object.fromEntries(result.passengers.map((p) => [p.passengerId, p]));
  assert.equal(byId.adult.status, "RISK");
  assert.equal(byId.wheel.status, "MISSED");
  assert.equal(byId.infant.status, "MISSED");
  assert.equal(byId.visa.status, "MISSED");
  assert.equal(byId.adult.requiredMinutes, 105);
  assert.equal(byId.wheel.requiredMinutes, 130);
});

test("风险归因指出瓶颈通行段（摆渡/安检/基础）", () => {
  const { catalog, journey } = tinyContext();
  const result = evaluateJourney(journey, [], {
    ruleCatalog: catalog,
    atMs: parseInstant("2026-09-12T20:00:00+08:00"),
  });
  const adult = result.passengers.find((p) => p.passengerId === "adult");
  const bySegment = Object.fromEntries(adult.reasons.map((r) => [r.segment, r]));
  assert.equal(bySegment.TRANSFER_BUS.minutes, 15);
  assert.equal(bySegment.SECURITY.minutes, 20);
  assert.equal(bySegment.BASE.minutes, 70);
  // 成人 slack=0、风险窗 20：只清零摆渡(15)或安检(20)仍在风险窗内，
  // 清零基础耗时 70 才能回升 OK——归因如实反映"哪段在起决定作用"
  assert.equal(bySegment.TRANSFER_BUS.wouldImprove, false);
  assert.equal(bySegment.BASE.wouldImprove, true);
  // 分段按耗时降序，主管第一眼看到最大瓶颈
  assert.equal(adult.reasons[0].segment, "BASE");
});

test("上游时刻变化后结论跟随更新（未确认建议）", () => {
  const { catalog, journey } = tinyContext();
  // 延误 20 分钟落地：成人也失接
  const late = evaluateJourney(journey, [
    {
      eventId: "e1",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:10:00+08:00",
    },
  ], { ruleCatalog: catalog, atMs: parseInstant("2026-09-12T20:05:00+08:00") });
  const adult = late.passengers.find((p) => p.passengerId === "adult");
  assert.equal(adult.status, "MISSED");

  // 追回 5 分钟：仍失接，但余量改善（乱序/重复事件由 store 层保证）
  const recovered = evaluateJourney(journey, [
    {
      eventId: "e2",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:10:00+08:00",
      time: "2026-09-12T23:05:00+08:00",
    },
    {
      eventId: "e1",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:10:00+08:00",
    },
  ], { ruleCatalog: catalog, atMs: parseInstant("2026-09-12T20:15:00+08:00") });
  const adult2 = recovered.passengers.find((p) => p.passengerId === "adult");
  assert.equal(adult2.status, "MISSED");
  assert.deepEqual(recovered.runState.appliedEventIds.sort(), ["e1", "e2"]);
});

// ---------------------------------------------------------------------------
// 存储：幂等、锁定、审计、回放
// ---------------------------------------------------------------------------

function newStore(journal) {
  const { catalog, journey } = tinyContext();
  return new Store({
    ruleCatalog: catalog,
    journeys: { j1: journey },
    journalPath: journal,
  });
}

test("同一运行事件重复推送只生成一份处置", () => {
  const { dir, journal } = tempJournal();
  try {
    const store = newStore(journal);
    const event = {
      eventId: "dup-1",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:10:00+08:00",
    };
    const first = store.ingestEvent(event);
    const second = store.ingestEvent({ ...event });
    assert.equal(first.duplicated, false);
    assert.equal(second.duplicated, true);

    const lines = readFileSync(journal, "utf8").trim().split("\n");
    // 1 条 event_applied + 4 位旅客各 1 条 evaluation，第二次推送 0 条
    const types = lines.map((l) => JSON.parse(l).type);
    assert.equal(types.filter((t) => t === "event_applied").length, 1);
    assert.equal(types.filter((t) => t === "evaluation").length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("柜台确认后后台重算不得覆盖；只追加 locked_observation", () => {
  const { dir, journal } = tempJournal();
  try {
    const store = newStore(journal);
    store.ingestEvent({
      eventId: "late-1",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:10:00+08:00",
    });
    // 柜台对成人执行改签
    const outcome = store.confirm({
      journeyId: "j1",
      passengerIds: ["adult"],
      decision: "REBOOK",
      idempotencyKey: "desk-42",
    });
    assert.equal(outcome[0].confirmed, true);

    // 上游继续恶化
    store.ingestEvent({
      eventId: "late-2",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:20:00+08:00",
      time: "2026-09-12T23:40:00+08:00",
    });

    const view = store.supervisorView("j1");
    const adult = view.passengers.find((p) => p.passengerId === "adult");
    assert.equal(adult.executedDecision, "REBOOK");
    assert.equal(adult.locked, true);
    assert.equal(adult.confirmation, undefined);
    // 后台观察值已更新，但决定不动
    assert.equal(adult.latestObservation.appliedEventIds.includes("late-2"), true);

    // 试图改判为放弃 -> 冲突，不覆盖
    const conflict = store.confirm({
      journeyId: "j1",
      passengerIds: ["adult"],
      decision: "ABANDON",
    });
    assert.equal(conflict[0].conflict, true);
    assert.equal(store.supervisorView("j1").passengers.find((p) => p.passengerId === "adult").executedDecision, "REBOOK");

    // 同键重复确认是幂等返回，不产生第二条 decision_confirmed
    const retry = store.confirm({
      journeyId: "j1",
      passengerIds: ["adult"],
      decision: "REBOOK",
      idempotencyKey: "desk-42",
    });
    assert.equal(retry[0].duplicated, true);

    const lines = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.type === "decision_confirmed").length, 1);
    assert.ok(lines.some((l) => l.type === "locked_observation" && l.passengerId === "adult"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("每次判断保存 ruleVersion 与数据哈希；重启回放锁定状态不变", () => {
  const { dir, journal } = tempJournal();
  try {
    const store1 = newStore(journal);
    store1.ingestEvent({
      eventId: "e-a",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:05:00+08:00",
    });
    store1.confirm({ journeyId: "j1", passengerIds: ["wheel"], decision: "KEEP" });
    const hashBefore = store1
      .supervisorView("j1")
      .passengers.find((p) => p.passengerId === "wheel").proposal.dataHash;
    assert.match(hashBefore, /^[0-9a-f]{64}$/);

    // 新进程：从 JSONL 回放
    const store2 = newStore(journal);
    const view = store2.supervisorView("j1");
    const wheel = view.passengers.find((p) => p.passengerId === "wheel");
    assert.equal(wheel.locked, true);
    assert.equal(wheel.executedDecision, "KEEP");
    assert.equal(view.ruleVersion, "mct-test");

    // 回放后再次推送重复事件仍然幂等
    const dup = store2.ingestEvent({
      eventId: "e-a",
      journeyId: "j1",
      type: "ARRIVAL_ESTIMATED",
      occurredAt: "2026-09-12T20:00:00+08:00",
      time: "2026-09-12T23:05:00+08:00",
    });
    assert.equal(dup.duplicated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("整组确认默认覆盖全组；婴儿等成员各自成行", () => {
  const { dir, journal } = tempJournal();
  try {
    const store = newStore(journal);
    const outcome = store.confirm({ journeyId: "j1", groupId: "g1", decision: "ABANDON" });
    assert.equal(outcome.length, 4);
    assert.ok(outcome.every((o) => o.confirmed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 波次优先级
// ---------------------------------------------------------------------------

test("波次列表把最需要先处理的未确认旅客排在前面", () => {
  const { dir, journal } = tempJournal();
  try {
    const { catalog, journey } = tinyContext();
    // 构造两个行程：j1 落地 22:50（成人 RISK），j2 落地 23:30 全员 OK
    const journey2 = {
      ...structuredClone(journey),
      journeyId: "j2",
      arrival: { ...journey.arrival, scheduledTime: "2026-09-12T23:30:00+08:00" },
      departure: { ...journey.departure, scheduledTime: "2026-09-13T03:00:00+08:00" },
    };
    const store = new Store({
      ruleCatalog: catalog,
      journeys: { j1: journey, j2: journey2 },
      journalPath: journal,
    });
    store.reevaluate("j1");
    store.reevaluate("j2");
    // 锁掉 j1 的婴儿（MISSED 已放弃），应沉到未确认者之后
    store.confirm({ journeyId: "j1", passengerIds: ["infant"], decision: "ABANDON" });

    const wave = store.wavePriority(
      "2026-09-12T22:00:00+08:00",
      "2026-09-13T02:00:00+08:00",
    );
    assert.equal(wave.count, 8);
    assert.equal(wave.items[0].status, "RISK");
    assert.equal(wave.items[0].passengerId, "adult");
    // 已锁定的婴儿排到末尾区域
    assert.equal(wave.items.at(-1).passengerId, "infant");
    assert.equal(wave.items.at(-1).locked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP：鉴权、旅客视图隔离
// ---------------------------------------------------------------------------

test("主管接口需要令牌；旅客接口只见本人", async () => {
  const { dir, journal } = tempJournal();
  const harness = await startServer(journal);
  try {
    // 无令牌
    const noToken = await jsonHttp(harness.base, "/api/journeys", { token: null });
    assert.equal(noToken.status, 401);

    // 推送一个延误事件
    const pushed = await jsonHttp(harness.base, "/api/events", {
      method: "POST",
      body: {
        eventId: "http-1",
        journeyId: "cx-1001",
        type: "ARRIVAL_ESTIMATED",
        occurredAt: "2026-09-12T20:00:00+08:00",
        time: "2026-09-12T23:05:00+08:00",
      },
    });
    assert.equal(pushed.status, 202);

    // 重复推送：不新建处置
    const again = await jsonHttp(harness.base, "/api/events", {
      method: "POST",
      body: {
        eventId: "http-1",
        journeyId: "cx-1001",
        type: "ARRIVAL_ESTIMATED",
        occurredAt: "2026-09-12T20:00:00+08:00",
        time: "2026-09-12T23:05:00+08:00",
      },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.ingested[0].duplicated, true);

    // 主管视图：含风险分段与规则版本
    const sup = await jsonHttp(harness.base, "/api/journeys/cx-1001");
    assert.equal(sup.status, 200);
    assert.equal(sup.body.ruleVersion, "mct-2026-09");
    assert.ok(Array.isArray(sup.body.passengers[0].riskFrom));

    // 旅客视图：不含其他旅客、不含航班号/他人标识
    const pax = await jsonHttp(harness.base, "/api/passengers/P1002", { token: null });
    assert.equal(pax.status, 200);
    const serialized = JSON.stringify(pax.body);
    assert.ok(!serialized.includes("P1001"));
    assert.ok(!serialized.includes("CA1832"));
    assert.ok(!serialized.includes("CA1519"));
    assert.ok(!serialized.includes("riskFrom"));
    assert.equal(pax.body.passengerId, "P1002");
    assert.ok(pax.body.basedOn.ruleVersion);

    // 查不到他人
    const missing = await jsonHttp(harness.base, "/api/passengers/NOBODY", { token: null });
    assert.equal(missing.status, 404);
  } finally {
    harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("柜台确认后再推事件，主管视图决定保持", async () => {
  const { dir, journal } = tempJournal();
  const harness = await startServer(journal);
  try {
    await jsonHttp(harness.base, "/api/decisions/confirm", {
      method: "POST",
      body: { journeyId: "cx-1001", passengerIds: ["P1002"], decision: "KEEP", idempotencyKey: "k-1" },
    });
    await jsonHttp(harness.base, "/api/events", {
      method: "POST",
      body: {
        eventId: "worse-1",
        journeyId: "cx-1001",
        type: "ARRIVAL_ESTIMATED",
        occurredAt: "2026-09-12T21:00:00+08:00",
        time: "2026-09-12T23:55:00+08:00",
      },
    });
    const sup = await jsonHttp(harness.base, "/api/journeys/cx-1001");
    const p = sup.body.passengers.find((x) => x.passengerId === "P1002");
    assert.equal(p.executedDecision, "KEEP");
    assert.equal(p.locked, true);
  } finally {
    harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("波次接口返回优先处理顺序", async () => {
  const { dir, journal } = tempJournal();
  const harness = await startServer(journal);
  try {
    const wave = await jsonHttp(
      harness.base,
      "/api/waves?from=2026-09-12T22:00:00%2B08:00&to=2026-09-13T02:00:00%2B08:00",
    );
    assert.equal(wave.status, 200);
    assert.equal(wave.body.count, 5);
    assert.ok(wave.body.items.length > 0);
  } finally {
    harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 衔接判断引擎（纯函数，无 I/O）。
//
// 输入：行程模板（fixtures 中的静态资料）+ 该行程收到的运行事件 + 评估时刻。
// 输出：每位旅客的结论（OK / RISK / MISSED）、逐段通行耗时拆解、
//       个人缓冲，以及"风险/失接由哪一段造成"的反事实归因。

import { MINUTE_MS, minutesToMs, parseInstant } from "./time.js";
import { RuleCatalog } from "./rules.js";

export const STATUS = Object.freeze({
  OK: "OK", // 预计落地后，按 MCT 能赶上后续航班
  RISK: "RISK", // 能赶上但余量不足（处于风险窗口）
  MISSED: "MISSED", // 按当前预计已无法衔接
});

/** 通行步骤 -> pair 规则中对应的分钟字段。 */
const STEP_FIELDS = Object.freeze({
  DEBOARD: null, // 下机耗时并入 baseMinutes，不单独计时
  TRANSFER_BUS: "transferBusMinutes",
  SECURITY: "securityMinutes",
  IMMIGRATION: "immigrationMinutes",
  WALK: "walkMinutes",
});

/**
 * 把一串运行事件折叠为"当前生效的运行态"。
 * 同一 eventId 只认一次（重复推送不产生第二份处置）；
 * 事件按 occurredAt 应用，乱序到达也能收敛到同一结果。
 */
export function reduceEvents(events) {
  const seen = new Set();
  const ordered = [];
  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    ordered.push(e);
  }
  ordered.sort((a, b) => parseInstant(a.occurredAt) - parseInstant(b.occurredAt));

  const state = {
    arrivalActualMs: null,
    arrivalEstimatedMs: null,
    departureEstimatedMs: null,
    departureActualMs: null,
    gateClosedMs: null,
    note: null,
    lastEventId: null,
    appliedEventIds: [...seen],
  };
  for (const e of ordered) {
    state.lastEventId = e.eventId;
    switch (e.type) {
      case "ARRIVAL_ESTIMATED":
        state.arrivalEstimatedMs = parseInstant(e.time);
        break;
      case "ARRIVAL_ACTUAL":
        state.arrivalActualMs = parseInstant(e.time);
        state.arrivalEstimatedMs = parseInstant(e.time);
        break;
      case "DEPARTURE_ESTIMATED":
        state.departureEstimatedMs = parseInstant(e.time);
        break;
      case "DEPARTURE_ACTUAL":
        state.departureActualMs = parseInstant(e.time);
        state.departureEstimatedMs = parseInstant(e.time);
        break;
      case "GATE_CLOSING":
        state.gateClosedMs = parseInstant(e.time);
        break;
      case "NOTE":
        state.note = e.message ?? state.note;
        break;
      default:
        // 未知事件类型忽略，前向兼容
        break;
    }
  }
  return state;
}

function plannedArrivalMs(journey) {
  return parseInstant(journey.arrival.scheduledTime ?? journey.arrival.time);
}
function plannedDepartureMs(journey) {
  return parseInstant(journey.departure.scheduledTime ?? journey.departure.time);
}

/** 逐段通行耗时（毫秒），只列出行程实际经过的步骤。 */
function buildSegments(journey, pair) {
  const segments = [];
  for (const step of journey.steps ?? []) {
    const field = STEP_FIELDS[step];
    if (field === null) continue;
    if (field === undefined) {
      // 资料里出现未知步骤：显式记为 0，而不是悄悄吞掉
      segments.push({ step, minutes: 0, source: "unknown" });
      continue;
    }
    const minutes = pair[field] ?? 0;
    segments.push({ step, minutes, source: field });
  }
  return segments;
}

/**
 * 评估一组同行旅客。
 * @param {object} journey fixtures 中的行程记录
 * @param {Array} events 已去重前的原始事件列表（函数内部再折叠）
 * @param {{ruleCatalog: RuleCatalog, atMs: number, riskWindowMs?: number}} ctx
 */
export function evaluateJourney(journey, events, ctx) {
  const { ruleCatalog, atMs } = ctx;
  const runState = reduceEvents(events);

  const scheduledArrivalMs = plannedArrivalMs(journey);
  const scheduledDepartureMs = plannedDepartureMs(journey);

  // "当时生效"以评估时刻选版本；评估时刻缺省取最新事件时刻
  const versionEffectiveAt = atMs ?? (runState.lastEventId ? latestEventMs(events) : scheduledArrivalMs);
  const version = ruleCatalog.versionAt(versionEffectiveAt);
  const pair = RuleCatalog.pairFor(version, journey.arrival.terminal, journey.departure.terminal);

  // 旅客可用的最晚到达（预计）时刻：实际 > 预计 > 计划
  const arrivalMs = runState.arrivalActualMs ?? runState.arrivalEstimatedMs ?? scheduledArrivalMs;
  // 后续航班截载（预计）时刻：实际 > 预计 > 计划
  const departureMs = runState.departureActualMs ?? runState.departureEstimatedMs ?? scheduledDepartureMs;
  const gateCloseMs = runState.gateClosedMs ?? departureMs - minutesToMs(15);

  const segments = buildSegments(journey, pair);
  const segmentMs = segments.reduce((sum, s) => sum + minutesToMs(s.minutes), 0);
  const baseMs = minutesToMs(pair.baseMinutes ?? 0);
  const riskWindowMs = ctx.riskWindowMs ?? ruleCatalog.riskWindowMs;

  const passengers = (journey.passengerGroup?.passengers ?? []).map((p) => {
    const buffers = (p.flags ?? []).map((flag) => ({
      flag,
      minutes: version.buffers[flag] ?? 0,
    }));
    const bufferMs = buffers.reduce((sum, b) => sum + minutesToMs(b.minutes), 0);

    const requiredMs = baseMs + segmentMs + bufferMs;
    const readyMs = arrivalMs + requiredMs; // 旅客预计抵达登机口的时刻
    const slackMs = gateCloseMs - readyMs; // 正=有余量，负=已失接

    let status;
    if (runState.departureActualMs !== null || slackMs < 0) status = STATUS.MISSED;
    else if (slackMs <= riskWindowMs) status = STATUS.RISK;
    else status = STATUS.OK;
    return {
      passengerId: p.passengerId,
      flags: p.flags ?? [],
      status,
      slackMs,
      slackMinutes: Math.round(slackMs / MINUTE_MS),
      requiredMinutes: Math.round(requiredMs / MINUTE_MS),
      buffers,
      reasons: attribute(slackMs, riskWindowMs, {
        baseMs,
        segments,
        bufferMs,
        departureHasActual: runState.departureActualMs !== null,
      }),
    };
  });

  return {
    journeyId: journey.journeyId,
    groupId: journey.passengerGroup?.groupId ?? null,
    ruleVersion: version.ruleVersion,
    evaluatedAtMs: versionEffectiveAt,
    arrival: {
      flight: journey.arrival.flight,
      terminal: journey.arrival.terminal,
      scheduledMs: scheduledArrivalMs,
      estimatedMs: runState.arrivalEstimatedMs,
      actualMs: runState.arrivalActualMs,
      usedMs: arrivalMs,
    },
    departure: {
      flight: journey.departure.flight,
      terminal: journey.departure.terminal,
      scheduledMs: scheduledDepartureMs,
      estimatedMs: runState.departureEstimatedMs,
      actualMs: runState.departureActualMs,
      gateCloseMs,
      usedMs: departureMs,
    },
    mct: {
      baseMinutes: pair.baseMinutes ?? 0,
      segments,
    },
    passengers,
    runState,
  };
}

function latestEventMs(events) {
  let max = -Infinity;
  for (const e of events) {
    const t = parseInstant(e.occurredAt);
    if (t > max) max = t;
  }
  return max === -Infinity ? Date.now() : max;
}

/**
 * 反事实归因：在不改变其他条件的前提下，逐段问一句——
 * "若这一段耗时为 0，结论能回升到哪一级？"
 * wouldImprove=true 表示该段清零后状态至少回升一级（MISSED→RISK/OK 或 RISK→OK），
 * 即这段通行耗时是当前风险/失接的直接贡献者；minutes 即主管看到的瓶颈耗时。
 */
function attribute(slackMs, riskWindowMs, parts) {
  if (slackMs > riskWindowMs) return [];
  const level = (s) => (s < 0 ? 0 : s <= riskWindowMs ? 1 : 2); // MISSED / RISK / OK
  const currentLevel = level(slackMs);
  const out = [];

  const push = (segment, minutes) => {
    const ms = minutesToMs(minutes ?? 0);
    out.push({
      segment,
      minutes: minutes ?? null,
      wouldImprove: level(slackMs + ms) > currentLevel,
    });
  };

  push("BASE", parts.baseMs / MINUTE_MS);
  for (const s of parts.segments) push(s.step, s.minutes);
  if (parts.bufferMs > 0) push("PASSENGER_BUFFER", parts.bufferMs / MINUTE_MS);
  if (parts.departureHasActual) {
    out.push({ segment: "FLIGHT_DEPARTED", minutes: null, wouldImprove: false });
  }

  out.sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1));
  return out;
}

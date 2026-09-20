// 决策服务编排：登记旅客/同行组 → 接收运行事件 → 重算未确认建议 → 柜台决定冻结。
import { randomUUID } from "node:crypto";
import {
  indexContext,
  effectiveRuleAt,
  evaluatePassenger,
  evaluateGroup,
  priorityRank,
  parseTime,
  STATUS,
} from "./domain.js";

export const DECISIONS = Object.freeze({
  RETAIN: "RETAIN", // 柜台已执行：保留原衔接
  REBOOK: "REBOOK", // 柜台已执行：改签
  ABANDON: "ABANDON", // 柜台已执行：放弃（如误机善后）
});

export class DecisionService {
  constructor(store, context, options = {}) {
    this.store = store;
    this.context = context;
    this.indexed = indexContext(context);
    this.riskWindowMinutes = options.riskWindowMinutes;
    this.now = options.now ?? (() => Date.now());
    store.state.runTimes ??= {}; // journeyId -> { ARRIVAL: {eventId,time,ms}, DEPARTURE: {...} }
  }

  /**
   * 登记旅客。同一 groupId 的成员作为一个同行组，组判定以最紧张成员为准；
   * 登记时即按计划时间生成初版建议，后续运行事件只刷新未确认的建议。
   */
  registerPassengers(incoming) {
    if (!Array.isArray(incoming) || incoming.length === 0) throw httpError(400, "empty_passengers");
    for (const passenger of incoming) {
      if (!passenger.passengerId) throw httpError(400, "missing_passengerId");
      if (!this.indexed.journeys.has(passenger.journeyId)) {
        throw httpError(400, `unknown_journey:${passenger.journeyId}`);
      }
    }

    // 先做全部校验，再落库，避免失败请求污染内存状态
    const current = this.store.listPassengers();
    const prospective = new Map(current.map((p) => [p.passengerId, p]));
    for (const passenger of incoming) {
      prospective.set(passenger.passengerId, { ...prospective.get(passenger.passengerId), ...passenger });
    }
    const groupIds = new Set(
      incoming.map((p) => p.groupId).filter((groupId) => groupId !== undefined && groupId !== null),
    );
    for (const groupId of groupIds) {
      const members = [...prospective.values()].filter((p) => p.groupId === groupId);
      const journeyIds = new Set(members.map((p) => p.journeyId));
      if (journeyIds.size > 1) throw httpError(400, `group_journey_mismatch:${groupId}`);
      const ids = members.map((m) => m.passengerId);
      const existing = this.store
        .listAdvice()
        .find(
          (entry) =>
            entry.kind === "GROUP" &&
            entry.journeyId === members[0].journeyId &&
            entry.passengerIds.some((id) => ids.includes(id)),
        );
      if (
        existing &&
        existing.decisionState === "CONFIRMED" &&
        !(existing.passengerIds.length === ids.length && existing.passengerIds.every((id) => ids.includes(id)))
      ) {
        throw httpError(409, `group_advice_locked:${groupId}`);
      }
    }

    this.store.upsertPassengers(incoming);
    const allPassengers = this.store.listPassengers();

    const created = [];
    // 组成员必须整体处理：以组当前全部成员为单位建/取建议
    for (const groupId of groupIds) {
      const members = allPassengers.filter((p) => p.groupId === groupId);
      created.push(this.#ensureAdviceForUnit(members, true));
    }
    // 无组旅客各自一条建议
    for (const passenger of incoming.filter((p) => p.groupId === undefined || p.groupId === null)) {
      created.push(this.#ensureAdviceForUnit([passenger], false));
    }
    return created;
  }

  #ensureAdviceForUnit(members, isGroup) {
    const ids = members.map((m) => m.passengerId);
    let advice = this.store.getAdviceByUnit(ids);
    if (!advice && isGroup) {
      // 同组后续补登成员：复用已有的组建议并扩充成员，而不是另建一条
      advice =
        this.store
          .listAdvice()
          .find(
            (entry) =>
              entry.kind === "GROUP" &&
              entry.journeyId === members[0].journeyId &&
              entry.passengerIds.some((id) => ids.includes(id)),
          ) ?? null;
      if (advice) advice.passengerIds = ids;
    }
    if (advice) return advice;
    advice = {
      adviceId: randomUUID(),
      kind: isGroup ? "GROUP" : "SINGLE",
      passengerIds: ids,
      journeyId: members[0].journeyId,
      waveId: members[0].waveId ?? null,
      status: STATUS.OK,
      decisionState: "PROPOSED", // PROPOSED -> CONFIRMED（柜台执行后冻结）
      counterAction: null, // { action, by, at }
      versions: { ruleVersion: null, contextVersion: this.indexed.contextVersion },
      basis: null, // 判定所依据的时间与事件
      members: [],
      governingPassengerId: null,
      riskContributors: [],
      history: [],
    };
    this.store.addAdvice(advice);
    this.#recomputeAdvice(advice);
    return advice;
  }

  /**
   * 接收运行事件。同一 eventId 重复推送直接返回，不产生第二份处置；
   * 新事件只重算相关行程上尚未确认的建议，柜台已执行的决定原样保留。
   */
  ingestEvent(event) {
    if (!event?.eventId) throw httpError(400, "missing_eventId");
    if (!event.journeyId) throw httpError(400, "missing_journeyId");
    if (!["ARRIVAL", "DEPARTURE"].includes(event.type)) throw httpError(400, "invalid_event_type");
    const ms = parseTime(event.actualTime, "actualTime");
    if (!this.indexed.journeys.has(event.journeyId)) {
      throw httpError(404, `unknown_journey:${event.journeyId}`);
    }

    if (this.store.hasEvent(event.eventId)) {
      return { duplicate: true, recomputed: [] };
    }
    this.store.markEvent(event.eventId);
    this.store.state.runTimes[event.journeyId] ??= {};
    this.store.state.runTimes[event.journeyId][event.type] = {
      eventId: event.eventId,
      time: event.actualTime,
      ms,
    };

    const recomputed = this.store
      .listAdvice()
      .filter((advice) => advice.journeyId === event.journeyId && advice.decisionState === "PROPOSED")
      .map((advice) => this.#recomputeAdvice(advice).adviceId);

    return { duplicate: false, recomputed };
  }

  #timeBasis(journeyId) {
    const journey = this.indexed.journeys.get(journeyId);
    const plannedArrivalMs = parseTime(journey.arrival.time, "arrival");
    const plannedDepartureMs = parseTime(journey.departure.time, "departure");
    const run = this.store.state.runTimes[journeyId] ?? {};
    return {
      arrival: run.ARRIVAL ?? { eventId: null, time: journey.arrival.time, ms: plannedArrivalMs },
      departure: run.DEPARTURE ?? { eventId: null, time: journey.departure.time, ms: plannedDepartureMs },
    };
  }

  #recomputeAdvice(advice) {
    if (advice.decisionState === "CONFIRMED") return advice; // 后台不得覆盖柜台决定

    const journey = this.indexed.journeys.get(advice.journeyId);
    const basis = this.#timeBasis(advice.journeyId);
    const rule = effectiveRuleAt(this.indexed.mctRules, journey.arrival.terminal, journey.departure.terminal, basis.arrival.ms);
    if (!rule) {
      throw httpError(422, `no_effective_mct_rule:${journey.arrival.terminal}->${journey.departure.terminal}`);
    }
    const transferTime = this.indexed.transferTimes.get(`${journey.arrival.terminal}->${journey.departure.terminal}`);

    const passengers = this.store.listPassengers();
    const memberResults = advice.passengerIds.map((id) => {
      const passenger = passengers.find((p) => p.passengerId === id);
      const result = evaluatePassenger({
        passenger,
        journey,
        transferTime,
        rule,
        arrivalMs: basis.arrival.ms,
        departureMs: basis.departure.ms,
        riskWindowMinutes: this.riskWindowMinutes,
      });
      return { passengerId: id, ...result };
    });

    const previous = { status: advice.status, slackMinutes: advice.slackMinutes };
    let status;
    let governingPassengerId;
    let slackMinutes;
    if (advice.kind === "GROUP") {
      const group = evaluateGroup(memberResults);
      status = group.status;
      governingPassengerId = group.governingPassengerId;
      slackMinutes = group.slackMinutes;
    } else {
      status = memberResults[0].status;
      governingPassengerId = memberResults[0].passengerId;
      slackMinutes = memberResults[0].slackMinutes;
    }

    Object.assign(advice, {
      status,
      slackMinutes,
      governingPassengerId,
      riskContributors: memberResults.find((m) => m.passengerId === governingPassengerId).riskContributors,
      members: memberResults.map(({ passengerId, status: memberStatus, slackMinutes: slack, requiredMctMinutes, mctComponents }) => ({
        passengerId,
        status: memberStatus,
        slackMinutes: slack,
        requiredMctMinutes,
        mctComponents,
      })),
    });
    advice.versions = { ruleVersion: rule.ruleVersion, contextVersion: this.indexed.contextVersion };
    advice.basis = {
      arrivalTime: basis.arrival.time,
      departureTime: basis.departure.time,
      arrivalEventId: basis.arrival.eventId,
      departureEventId: basis.departure.eventId,
      computedAt: new Date(this.now()).toISOString(),
    };
    advice.history.push({
      at: advice.basis.computedAt,
      fromStatus: previous.status,
      toStatus: status,
      slackMinutes,
      ruleVersion: rule.ruleVersion,
    });
    return advice;
  }

  /** 柜台执行决定：保留/改签/放弃。确认后该建议被冻结，后续事件不再重算。 */
  applyCounterDecision(adviceId, action, by = "counter") {
    const advice = this.store.getAdvice(adviceId);
    if (!advice) throw httpError(404, "advice_not_found");
    if (!DECISIONS[action]) throw httpError(400, `invalid_action:${action}`);
    if (advice.decisionState === "CONFIRMED") {
      throw httpError(409, `advice_already_confirmed:${advice.counterAction.action}`);
    }
    advice.decisionState = "CONFIRMED";
    advice.counterAction = { action, by, at: new Date(this.now()).toISOString() };
    return advice;
  }

  /** 主管视图：某到达波次中最需要先处理的人（已失接 > 风险 > 可衔接，同档富余少者优先） */
  wavePriority(waveId) {
    const entries = this.store
      .listAdvice()
      .filter((advice) => advice.waveId === waveId)
      .map((advice) => ({ ...this.supervisorView(advice), waveId }));
    return priorityRank(entries);
  }

  /** 主管视图：含真实姓名、航班、分段风险来源、每位成员的缓冲条件 */
  supervisorView(advice) {
    const journey = this.indexed.journeys.get(advice.journeyId);
    const passengers = this.store.listPassengers();
    return {
      adviceId: advice.adviceId,
      kind: advice.kind,
      waveId: advice.waveId,
      status: advice.status,
      slackMinutes: advice.slackMinutes,
      decisionState: advice.decisionState,
      counterAction: advice.counterAction,
      versions: advice.versions,
      basis: advice.basis,
      journey: {
        journeyId: advice.journeyId,
        arrivalFlight: journey.arrival.flight,
        departureFlight: journey.departure.flight,
        fromTerminal: journey.arrival.terminal,
        toTerminal: journey.departure.terminal,
      },
      members: advice.members.map((member) => {
        const passenger = passengers.find((p) => p.passengerId === member.passengerId);
        return { ...member, name: passenger?.name ?? null, flags: passenger?.flags ?? [] };
      }),
      governingPassengerId: advice.governingPassengerId,
      riskContributors: advice.riskContributors,
    };
  }

  listSupervisorAdvice({ waveId } = {}) {
    return this.store
      .listAdvice()
      .filter((advice) => !waveId || advice.waveId === waveId)
      .map((advice) => this.supervisorView(advice));
  }

  /**
   * 旅客视图：只能查本人；同行组中其他人只显示编号，不显示身份与标记；
   * 不暴露任何非本人相关的建议行。
   */
  passengerView(passengerId) {
    const advice = this.store
      .listAdvice()
      .find((entry) => entry.passengerIds.includes(passengerId));
    if (!advice) throw httpError(404, "advice_not_found");
    const own = advice.members.find((member) => member.passengerId === passengerId);
    return {
      adviceId: advice.adviceId,
      status: advice.status, // 同行组整体结论
      yourStatus: own.status,
      slackMinutes: advice.slackMinutes,
      decisionState: advice.decisionState,
      counterAction: advice.counterAction?.action ?? null,
      groupSize: advice.passengerIds.length,
      fellowTravelers: advice.passengerIds
        .filter((id) => id !== passengerId)
        .map((id, index) => ({ seat: `同行旅客${index + 1}` })),
      versions: advice.versions,
      basis: advice.basis,
    };
  }
}

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  return error;
}

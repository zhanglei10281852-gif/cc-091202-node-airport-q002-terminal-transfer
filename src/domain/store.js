// 状态存储 + 只追加审计日志。
//
// 关键不变量：
// 1. 同一 eventId 永远只处理一次（重复推送不产生第二份处置）。
// 2. 建议有生命周期 PROPOSED -> CONFIRMED_{KEEP,REBOOK,ABANDON}：
//    上游时刻反复变化时只重算 PROPOSED；柜台一旦确认，决定锁定，
//    后台重算结果只能另存为 latestObservation，绝不覆盖 executedDecision。
// 3. 每次判断都把命中的 ruleVersion 与输入数据的 dataHash 追加到 JSONL，
//    重启后通过回放日志重建状态，历史判断依据可追溯。

import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateJourney, STATUS } from "./engine.js";
import { parseInstant } from "./time.js";

export const DECISION = Object.freeze({
  KEEP: "KEEP", // 柜台执行：保留原衔接（派人加急引导）
  REBOOK: "REBOOK", // 柜台执行：提前改签
  ABANDON: "ABANDON", // 柜台执行：放弃该衔接
});
const CONFIRMED = new Set([DECISION.KEEP, DECISION.REBOOK, DECISION.ABANDON]);

/** 对判断输入做规范哈希，记录"这份结论是基于哪一版数据算出来的"。 */
export function hashInputs(version, journey, appliedEventIds) {
  const canonical = JSON.stringify({
    ruleVersion: version.ruleVersion,
    rules: { pairs: version.pairs, buffers: version.buffers },
    journey,
    appliedEventIds: [...appliedEventIds].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class Store {
  /**
   * @param {object} deps
   * @param {import("./rules.js").RuleCatalog} deps.ruleCatalog
   * @param {Record<string, object>} deps.journeys journeyId -> 行程记录
   * @param {string=} deps.journalPath JSONL 审计日志路径；null 表示纯内存
   */
  constructor({ ruleCatalog, journeys, journalPath = null }) {
    this.ruleCatalog = ruleCatalog;
    /** @type {Map<string, object>} */
    this.journeys = new Map(Object.entries(journeys ?? {}));
    /** @type {Map<string, object[]>} journeyId -> 事件（保持应用顺序） */
    this.events = new Map();
    /** @type {Set<string>} 全局已处理 eventId，幂等闸门 */
    this.seenEventIds = new Set();
    /** @type {Map<string, object>} 键 journeyId:passengerId -> 处置行 */
    this.rows = new Map();
    this.journalPath = journalPath;
    if (journalPath) {
      mkdirSync(dirname(journalPath), { recursive: true });
      this.#replay();
    }
  }

  getJourney(journeyId) {
    return this.journeys.get(journeyId);
  }

  listJourneys() {
    return [...this.journeys.values()];
  }

  #append(record) {
    if (!this.journalPath) return;
    appendFileSync(
      this.journalPath,
      `${JSON.stringify({ loggedAt: new Date().toISOString(), ...record })}\n`,
    );
  }

  #replay() {
    if (!existsSync(this.journalPath)) return;
    const lines = readFileSync(this.journalPath, "utf8")
      .split("\n")
      .filter(Boolean);
    // 回放期间关闭追加，避免重复写盘
    const path = this.journalPath;
    this.journalPath = null;
    for (const line of lines) {
      const rec = JSON.parse(line);
      this.#applyJournalRecord(rec);
    }
    this.journalPath = path;
  }

  #applyJournalRecord(rec) {
    switch (rec.type) {
      case "event_applied":
        if (!this.seenEventIds.has(rec.event.eventId)) {
          this.seenEventIds.add(rec.event.eventId);
          this.#putEvent(rec.event);
        }
        break;
      case "evaluation": {
        const key = `${rec.journeyId}:${rec.passengerId}`;
        const existing = this.rows.get(key);
        if (existing) {
          existing.latestObservation = rec.snapshot;
        } else {
          this.rows.set(key, {
            journeyId: rec.journeyId,
            passengerId: rec.passengerId,
            groupId: rec.groupId,
            proposal: rec.snapshot,
            proposals: [rec.snapshot],
            executedDecision: null,
            latestObservation: rec.snapshot,
          });
        }
        break;
      }
      case "proposal_updated": {
        const row = this.rows.get(`${rec.journeyId}:${rec.passengerId}`);
        if (row && !row.executedDecision) {
          row.proposal = rec.snapshot;
          row.proposals.push(rec.snapshot);
          row.latestObservation = rec.snapshot;
        }
        break;
      }
      case "locked_observation": {
        const row = this.rows.get(`${rec.journeyId}:${rec.passengerId}`);
        if (row) row.latestObservation = rec.snapshot;
        break;
      }
      case "decision_confirmed": {
        const row = this.rows.get(`${rec.journeyId}:${rec.passengerId}`);
        if (row) {
          row.executedDecision = rec.decision;
          row.confirmedAt = rec.confirmedAt;
          row.confirmIdempotencyKey = rec.idempotencyKey;
          row.confirmation = rec.snapshot;
        }
        break;
      }
      default:
        break;
    }
  }

  #putEvent(event) {
    const list = this.events.get(event.journeyId) ?? [];
    list.push(event);
    this.events.set(event.journeyId, list);
  }

  /**
   * 摄入一个运行事件（幂等）。
   * @returns {{duplicated:boolean, journeyId:string, eventId:string}}
   */
  ingestEvent(event) {
    if (!event || !event.eventId || !event.journeyId || !event.type || !event.occurredAt) {
      throw new Error("invalid_event: require eventId, journeyId, type, occurredAt");
    }
    parseInstant(event.occurredAt);
    if (event.time) parseInstant(event.time);
    if (this.seenEventIds.has(event.eventId)) {
      return { duplicated: true, journeyId: event.journeyId, eventId: event.eventId };
    }
    if (!this.journeys.has(event.journeyId)) {
      throw new Error(`unknown_journey:${event.journeyId}`);
    }
    this.seenEventIds.add(event.eventId);
    this.#putEvent(event);
    this.#append({ type: "event_applied", event });

    this.reevaluate(event.journeyId, "event");
    return { duplicated: false, journeyId: event.journeyId, eventId: event.eventId };
  }

  /** 纯计算行程当前态，不写状态、不追加日志（读路径使用）。 */
  #compute(journeyId) {
    const journey = this.journeys.get(journeyId);
    if (!journey) throw new Error(`unknown_journey:${journeyId}`);
    const events = this.events.get(journeyId) ?? [];
    return evaluateJourney(journey, events, {
      ruleCatalog: this.ruleCatalog,
      atMs: Date.now(),
    });
  }

  /** 把引擎结果中的一位旅客组装成可持久化/可展示的快照。 */
  #snapshotFor(result, journey, p, reason) {
    const version = this.ruleCatalog.versionAt(result.evaluatedAtMs);
    return {
      at: new Date().toISOString(),
      reason,
      status: p.status,
      slackMinutes: p.slackMinutes,
      requiredMinutes: p.requiredMinutes,
      segments: result.mct.segments,
      buffers: p.buffers,
      reasons: p.reasons,
      times: {
        arrivalUsed: new Date(result.arrival.usedMs).toISOString(),
        departureUsed: new Date(result.departure.usedMs).toISOString(),
        gateClose: new Date(result.departure.gateCloseMs).toISOString(),
      },
      ruleVersion: result.ruleVersion,
      dataHash: hashInputs(version, journey, result.runState.appliedEventIds),
      appliedEventIds: result.runState.appliedEventIds,
    };
  }

  /**
   * 针对一个行程重算全部旅客处置（写路径）。
   * PROPOSED 行跟随最新数据更新；已确认行只记录观察值，决定不动。
   */
  reevaluate(journeyId, reason = "manual") {
    const journey = this.journeys.get(journeyId);
    if (!journey) throw new Error(`unknown_journey:${journeyId}`);
    const result = this.#compute(journeyId);

    for (const p of result.passengers) {
      const key = `${journeyId}:${p.passengerId}`;
      const snapshot = this.#snapshotFor(result, journey, p, reason);

      const row = this.rows.get(key);
      if (!row) {
        this.rows.set(key, {
          journeyId,
          passengerId: p.passengerId,
          groupId: result.groupId,
          proposal: snapshot,
          proposals: [snapshot],
          executedDecision: null,
          latestObservation: snapshot,
        });
        this.#append({
          type: "evaluation",
          journeyId,
          passengerId: p.passengerId,
          groupId: result.groupId,
          snapshot,
        });
      } else if (row.executedDecision) {
        // 柜台已执行：后台重算不得覆盖，只留观察痕迹
        row.latestObservation = snapshot;
        this.#append({
          type: "locked_observation",
          journeyId,
          passengerId: p.passengerId,
          executedDecision: row.executedDecision,
          snapshot,
        });
      } else {
        row.proposal = snapshot;
        row.proposals.push(snapshot);
        row.latestObservation = snapshot;
        this.#append({
          type: "proposal_updated",
          journeyId,
          passengerId: p.passengerId,
          groupId: result.groupId,
          snapshot,
        });
      }
    }
    return result;
  }

  /** 行程的主管视图：建议、锁定决定、最新观察全部可见（只读，不写日志）。 */
  supervisorView(journeyId) {
    const result = this.#compute(journeyId);
    return {
      journeyId,
      groupId: result.groupId,
      ruleVersion: result.ruleVersion,
      legs: {
        arrival: {
          flight: result.arrival.flight,
          terminal: result.arrival.terminal,
          scheduled: new Date(result.arrival.scheduledMs).toISOString(),
          estimated: result.arrival.estimatedMs ? new Date(result.arrival.estimatedMs).toISOString() : null,
          actual: result.arrival.actualMs ? new Date(result.arrival.actualMs).toISOString() : null,
        },
        departure: {
          flight: result.departure.flight,
          terminal: result.departure.terminal,
          scheduled: new Date(result.departure.scheduledMs).toISOString(),
          estimated: result.departure.estimatedMs ? new Date(result.departure.estimatedMs).toISOString() : null,
          actual: result.departure.actualMs ? new Date(result.departure.actualMs).toISOString() : null,
          gateClose: new Date(result.departure.gateCloseMs).toISOString(),
        },
      },
      mct: result.mct,
      passengers: result.passengers.map((p) => {
        const row = this.rows.get(`${journeyId}:${p.passengerId}`);
        return {
          passengerId: p.passengerId,
          flags: p.flags,
          currentStatus: p.status,
          slackMinutes: p.slackMinutes,
          buffers: p.buffers,
          riskFrom: p.reasons,
          locked: Boolean(row?.executedDecision),
          proposal: row?.proposal ?? null,
          executedDecision: row?.executedDecision ?? null,
          confirmedAt: row?.confirmedAt ?? null,
          latestObservation: row?.latestObservation ?? null,
        };
      }),
    };
  }

  /**
   * 柜台确认处置。确认后该行永久锁定，后续事件不再改变决定。
   * 默认按整组（groupId）处理；可传 passengerIds 只确认部分成员，
   * 已锁定的成员不会被改写。
   */
  confirm({ journeyId, groupId, passengerIds, decision, note = null, idempotencyKey, confirmedAt = new Date().toISOString() }) {
    if (!CONFIRMED.has(decision)) throw new Error(`invalid_decision:${decision}`);
    const journey = this.journeys.get(journeyId);
    if (!journey) throw new Error(`unknown_journey:${journeyId}`);

    // 柜台可能在尚未推送任何事件时直接处置：先按当前资料播种建议行
    if (![...this.rows.values()].some((r) => r.journeyId === journeyId)) {
      this.reevaluate(journeyId, "pre_confirm");
    }

    let targets = [...this.rows.values()].filter((r) => r.journeyId === journeyId);
    if (passengerIds) targets = targets.filter((r) => passengerIds.includes(r.passengerId));
    else if (groupId) targets = targets.filter((r) => r.groupId === groupId);
    if (targets.length === 0) throw new Error("no_matching_passengers");

    const outcome = [];
    for (const row of targets) {
      if (row.executedDecision) {
        if (row.executedDecision === decision && row.confirmIdempotencyKey === idempotencyKey) {
          outcome.push({ passengerId: row.passengerId, duplicated: true, decision });
          continue;
        }
        // 已执行别的处置：拒绝覆盖
        outcome.push({
          passengerId: row.passengerId,
          conflict: true,
          existingDecision: row.executedDecision,
        });
        continue;
      }
      row.executedDecision = decision;
      row.confirmedAt = confirmedAt;
      row.confirmIdempotencyKey = idempotencyKey ?? null;
      row.confirmation = { ...row.proposal, note };
      this.#append({
        type: "decision_confirmed",
        journeyId,
        passengerId: row.passengerId,
        decision,
        note,
        idempotencyKey: idempotencyKey ?? null,
        confirmedAt,
        snapshot: row.confirmation,
      });
      outcome.push({ passengerId: row.passengerId, confirmed: true, decision });
    }
    return outcome;
  }

  /**
   * 到达波次优先级：在 [fromMs,toMs) 计划落地窗口内，
   * 未确认旅客按"最该先处理"排序——可挽救的紧衔接(RISK)优先于已失接(MISSED)，
   * 同级内余量越少越靠前。已确认者沉底，便于主管看到还剩谁没动。
   */
  wavePriority(fromIso, toIso) {
    const fromMs = parseInstant(fromIso);
    const toMs = parseInstant(toIso);
    const rank = { [STATUS.RISK]: 0, [STATUS.MISSED]: 1, [STATUS.OK]: 2 };
    const items = [];
    for (const journey of this.journeys.values()) {
      const schedMs = parseInstant(journey.arrival.scheduledTime ?? journey.arrival.time);
      if (schedMs < fromMs || schedMs >= toMs) continue;
      const view = this.supervisorView(journey.journeyId);
      for (const p of view.passengers) {
        items.push({
          journeyId: journey.journeyId,
          groupId: view.groupId,
          passengerId: p.passengerId,
          flags: p.flags,
          status: p.currentStatus,
          slackMinutes: p.slackMinutes,
          locked: p.locked,
          executedDecision: p.executedDecision,
          riskFrom: p.riskFrom,
          ruleVersion: view.ruleVersion,
          arrivalFlight: view.legs.arrival.flight,
          departureFlight: view.legs.departure.flight,
          arrivalTerminal: view.legs.arrival.terminal,
          departureTerminal: view.legs.departure.terminal,
        });
      }
    }
    items.sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? 1 : -1;
      const r = rank[a.status] - rank[b.status];
      if (r !== 0) return r;
      if (a.status === STATUS.MISSED) {
        // 越接近赶上（-5 比 -90）越可能靠加急引导抢回，优先处理
        return b.slackMinutes - a.slackMinutes;
      }
      // RISK：余量越少越急；OK：余量越少越值得关注
      return a.slackMinutes - b.slackMinutes;
    });
    return { from: fromIso, to: toIso, count: items.length, items };
  }

  /** 旅客自助视图：只含本人信息，看不到同组/他人身份与行程。 */
  passengerView(passengerId) {
    const row = [...this.rows.values()].find((r) => r.passengerId === passengerId);
    if (!row) return null;
    const view = this.supervisorView(row.journeyId);
    const p = view.passengers.find((x) => x.passengerId === passengerId);
    return {
      passengerId,
      status: p.currentStatus,
      slackMinutes: p.slackMinutes,
      locked: p.locked,
      actionTaken: p.executedDecision
        ? { KEEP: "HOLD", REBOOK: "REBOOKED", ABANDON: "CONNECTION_RELEASED" }[p.executedDecision]
        : null,
      basedOn: {
        ruleVersion: p.proposal?.ruleVersion ?? view.ruleVersion,
        asOf: (p.latestObservation ?? p.proposal)?.at ?? null,
      },
      flights: {
        arrival: { terminal: view.legs.arrival.terminal },
        departure: { terminal: view.legs.departure.terminal },
      },
    };
  }
}

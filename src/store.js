// 简单的 JSON 文件持久化：原子写入（同目录临时文件 + rename），崩溃时不会留下半截状态。
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  passengers: [], // { passengerId, groupId, name, journeyId, flags, waveId }
  appliedEvents: [], // 已处理的事件 eventId，保证重复推送不产生第二份处置
  advice: [], // 建议记录（结构见 service.js）
});

export class JsonStore {
  constructor(filePath, state = structuredClone(EMPTY_STATE)) {
    this.filePath = filePath;
    this.state = state;
  }

  static async open(filePath) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return new JsonStore(filePath, { ...structuredClone(EMPTY_STATE), ...parsed });
    } catch (error) {
      if (error.code === "ENOENT") return new JsonStore(filePath);
      throw error;
    }
  }

  listPassengers() {
    return this.state.passengers;
  }

  upsertPassengers(passengers) {
    for (const incoming of passengers) {
      const index = this.state.passengers.findIndex((p) => p.passengerId === incoming.passengerId);
      const record = {
        passengerId: incoming.passengerId,
        groupId: incoming.groupId ?? null,
        name: incoming.name,
        journeyId: incoming.journeyId,
        flags: incoming.flags ?? [],
        waveId: incoming.waveId ?? null,
      };
      if (index >= 0) this.state.passengers[index] = record;
      else this.state.passengers.push(record);
    }
  }

  hasEvent(eventId) {
    return this.state.appliedEvents.includes(eventId);
  }

  markEvent(eventId) {
    if (!this.hasEvent(eventId)) this.state.appliedEvents.push(eventId);
  }

  listAdvice() {
    return this.state.advice;
  }

  getAdvice(adviceId) {
    return this.state.advice.find((advice) => advice.adviceId === adviceId) ?? null;
  }

  /** 同一旅客/同一同行组只保留一条建议；重复注册返回既有记录 */
  getAdviceByUnit(passengerIds) {
    const keySet = new Set(passengerIds);
    return (
      this.state.advice.find((advice) =>
        advice.passengerIds.every((id) => keySet.has(id)) &&
        advice.passengerIds.length === keySet.size,
      ) ?? null
    );
  }

  addAdvice(advice) {
    this.state.advice.push(advice);
    return advice;
  }

  async persist() {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const serializable = structuredClone(this.state);
    await writeFile(tmp, JSON.stringify(serializable, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

export { EMPTY_STATE };

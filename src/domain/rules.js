// 最短衔接规则（MCT）目录与版本选择。
// 规则按版本发布，每个版本有 effectiveFrom（绝对时刻）。
// 判断时使用"评估当时已经生效的最新版本"——历史判断不会因规则更新而改变语义，
// 每次判断还会把命中的 ruleVersion 落盘，便于复盘"当时依据哪一版"。

import { parseInstant } from "./time.js";

export class RuleCatalog {
  /**
   * @param {Array<{ruleVersion:string, effectiveFrom:string, pairs:Array, buffers:Record<string,number>}>} versions
   */
  constructor(versions, riskWindowMinutes = 20) {
    /** @type {Array<{ruleVersion:string, effectiveFromMs:number, pairs:Array, buffers:Record<string,number>}>} */
    this.versions = versions
      .map((v) => ({
        ruleVersion: v.ruleVersion,
        effectiveFromMs: parseInstant(v.effectiveFrom),
        pairs: v.pairs ?? [],
        buffers: v.buffers ?? {},
      }))
      .sort((a, b) => a.effectiveFromMs - b.effectiveFromMs);
    this.riskWindowMs = riskWindowMinutes * 60_000;
  }

  /** 返回评估时刻生效中的最新规则版本；没有任何版本生效时抛错。 */
  versionAt(atMs) {
    let hit;
    for (const v of this.versions) {
      if (v.effectiveFromMs <= atMs) hit = v;
      else break;
    }
    if (!hit) throw new Error("no_effective_rule_version");
    return hit;
  }

  /** 航站楼对规则：精确 from/to 优先，否则退回 "*" 通配。 */
  static pairFor(version, fromTerminal, toTerminal) {
    const exact = version.pairs.find(
      (p) => p.from === fromTerminal && p.to === toTerminal,
    );
    if (exact) return exact;
    const wildcard = version.pairs.find((p) => p.from === "*" && p.to === "*");
    if (wildcard) return wildcard;
    throw new Error(`no_mct_pair:${fromTerminal}->${toTerminal}`);
  }
}

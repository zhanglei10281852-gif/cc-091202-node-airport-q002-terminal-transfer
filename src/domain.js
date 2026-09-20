// 跨航站楼中转衔接判定：纯领域逻辑，不碰 HTTP 与存储，便于对时区与跨午夜场景做稳定测试。

export const STATUS = Object.freeze({
  OK: "OK", // 可衔接
  RISK: "RISK", // 有风险，需要主管关注
  MISSED: "MISSED", // 已失接，应改签/放弃
});

const STATUS_RANK = { [STATUS.OK]: 0, [STATUS.RISK]: 1, [STATUS.MISSED]: 2 };

// 与 fixtures 中的步骤标识对应
const STEP_LABELS = Object.freeze({
  DEBOARD: "下机",
  TRANSFER_BUS: "跨楼摆渡车",
  WALK: "楼内步行",
  SECURITY: "重新安检",
  IMMIGRATION: "过境/边检",
  MCT_BASE: "基础衔接",
});

const FLAG_LABELS = Object.freeze({
  WHEELCHAIR: "轮椅服务",
  INFANT: "婴儿同行",
  TRANSIT_VISA_CHECK: "需过境检查",
});

// 风险窗口默认值：富余时间小于该分钟数即判为 RISK
export const DEFAULT_RISK_WINDOW_MINUTES = 20;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 严格解析带时区偏移量的 ISO 时间，返回 epoch 毫秒。
 * 拒绝无时区的本地时间，避免跨机场部署时产生歧义。
 */
export function parseTime(value, field = "time") {
  if (typeof value !== "string" || !ISO_RE.test(value)) {
    throw new Error(`invalid_${field}:${String(value)}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid_${field}:${value}`);
  }
  return ms;
}

/** 按记录类型拆分资料包 */
export function indexContext(context) {
  const journeys = new Map();
  const transferTimes = new Map();
  const mctRules = [];
  for (const record of context.records ?? []) {
    if (record.type === "journey" || (!record.type && record.journeyId)) {
      journeys.set(record.journeyId, record);
    } else if (record.type === "transferTime") {
      transferTimes.set(terminalPairKey(record.from, record.to), record);
    } else if (record.type === "mctRule") {
      mctRules.push(record);
    }
  }
  return {
    contextVersion: context.contextVersion ?? "unversioned",
    journeys,
    transferTimes,
    mctRules,
  };
}

export function terminalPairKey(from, to) {
  return `${from}->${to}`;
}

/**
 * 选取某一时刻对某条航站楼动线生效的 MCT 规则。
 * 同一时刻有多条生效时，取 effectiveFrom 最晚的一条（支持规则换版灰度）。
 */
export function effectiveRuleAt(mctRules, from, to, arrivalMs) {
  const candidates = mctRules
    .filter((rule) => rule.from === from && rule.to === to)
    .filter((rule) => {
      const start = parseTime(rule.effectiveFrom, "effectiveFrom");
      const end = rule.effectiveTo ? parseTime(rule.effectiveTo, "effectiveTo") : Number.POSITIVE_INFINITY;
      return arrivalMs >= start && arrivalMs <= end;
    })
    .sort((a, b) => parseTime(b.effectiveFrom, "effectiveFrom") - parseTime(a.effectiveFrom, "effectiveFrom"));
  return candidates[0] ?? null;
}

/**
 * 计算一名旅客所需的最短衔接分钟数：
 * 基础 MCT + 动线触发的安检/边检分量 + 该旅客自身的特殊缓冲。
 * 同行组内每名成员独立计算（婴儿、轮椅、过境检查缓冲各不相同）。
 */
export function requiredMctMinutes(rule, journey, flags = []) {
  let minutes = rule.baseMinutes ?? 0;
  const components = [{ key: "MCT_BASE", minutes }];

  if (journey.steps.includes("SECURITY")) {
    const value = rule.securityMinutes ?? 0;
    minutes += value;
    components.push({ key: "SECURITY", minutes: value });
  }
  if (journey.steps.includes("IMMIGRATION")) {
    const value = rule.immigrationMinutes ?? 0;
    minutes += value;
    components.push({ key: "IMMIGRATION", minutes: value });
  }
  for (const flag of flags) {
    const value = rule.buffers?.[flag] ?? 0;
    if (value > 0) {
      minutes += value;
      components.push({ key: `BUFFER:${flag}`, minutes: value, flag });
    }
  }
  return { minutes, components };
}

function classifySlack(slackMinutes, riskWindowMinutes) {
  if (slackMinutes < 0) return STATUS.MISSED;
  if (slackMinutes <= riskWindowMinutes) return STATUS.RISK;
  return STATUS.OK;
}

/**
 * 判定单个旅客。eventTimes 为 { arrivalMs, departureMs }，由服务端用最新运行事件覆盖计划时间得到。
 * 返回值包含结论、富余分钟、规则/资料版本，以及向主管解释风险来源的分段耗时。
 */
export function evaluatePassenger({
  passenger,
  journey,
  transferTime,
  rule,
  arrivalMs,
  departureMs,
  riskWindowMinutes = DEFAULT_RISK_WINDOW_MINUTES,
}) {
  const required = requiredMctMinutes(rule, journey, passenger.flags ?? []);
  const availableMs = departureMs - arrivalMs;
  const availableMinutes = roundMinute(availableMs / 60000);
  const slackMinutes = roundMinute(availableMinutes - required.minutes);
  const status = classifySlack(slackMinutes, riskWindowMinutes);

  return {
    status,
    slackMinutes,
    availableMinutes,
    requiredMctMinutes: required.minutes,
    mctComponents: required.components,
    riskContributors: buildRiskContributors(journey, transferTime, required.components),
    ruleVersion: rule.ruleVersion,
  };
}

/**
 * 把通行耗时表中的各段分钟数与 MCT 分量合并，按耗时降序返回，
 * 主管据此看到风险究竟来自摆渡、边检、复检还是特殊旅客缓冲。
 */
function buildRiskContributors(journey, transferTime, mctComponents) {
  const observedSteps = transferTime?.steps ?? {};
  const contributors = [];
  for (const step of journey.steps ?? []) {
    const minutes = observedSteps[step] ?? null;
    contributors.push({
      key: step,
      label: STEP_LABELS[step] ?? step,
      observedMinutes: minutes,
    });
  }
  for (const component of mctComponents) {
    if (component.key.startsWith("BUFFER:")) {
      contributors.push({
        key: component.key,
        label: `${FLAG_LABELS[component.flag] ?? component.flag}缓冲`,
        bufferMinutes: component.minutes,
      });
    }
  }
  return contributors
    .filter((item) => (item.observedMinutes ?? item.bufferMinutes ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.observedMinutes ?? b.bufferMinutes ?? 0) - (a.observedMinutes ?? a.bufferMinutes ?? 0),
    );
}

/**
 * 同行旅客成组判定：以组内要求最高（富余最小）的成员为准，
 * 轮椅/婴儿/过境检查成员各自带着自己的缓冲参与比较。
 */
export function evaluateGroup(memberResults) {
  if (memberResults.length === 0) throw new Error("empty_group");
  const governing = memberResults.reduce((worst, current) =>
    current.slackMinutes < worst.slackMinutes ? current : worst,
  );
  const status = memberResults.reduce((worst, current) =>
    STATUS_RANK[current.status] > STATUS_RANK[worst.status] ? current : worst,
  ).status;
  return {
    status,
    governingPassengerId: governing.passengerId,
    slackMinutes: governing.slackMinutes,
  };
}

/**
 * 到达波次处置优先级：已失接 > 风险 > 可衔接；同档内富余时间越少越靠前。
 */
export function priorityRank(entries) {
  return [...entries].sort((a, b) => {
    const rankDiff = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (rankDiff !== 0) return rankDiff;
    return a.slackMinutes - b.slackMinutes;
  });
}

function roundMinute(value) {
  return Math.round(value * 10) / 10;
}

export { STEP_LABELS, FLAG_LABELS };

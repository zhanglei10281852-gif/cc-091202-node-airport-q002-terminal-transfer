// 所有时刻一律解析为绝对毫秒（epoch millis）后比较：
// 跨午夜的"落地 22:50、起飞 00:50"只是时区墙上的时钟回绕，
// 带偏移量（+08:00 / Z / +05:30）的 ISO 字符串经 Date 解析后天然可比，
// 不做任何字符串或"分钟数"层面的相减。

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 解析带明确时区偏移量的 ISO 8601 时刻。
 * 拒绝无时区后缀的字符串，避免按服务器本地时区静默解释。
 * @param {string} iso
 * @returns {number} epoch millis
 */
export function parseInstant(iso) {
  if (typeof iso !== "string" || !ISO_WITH_OFFSET.test(iso)) {
    throw new Error(`invalid_instant:${iso}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid_instant:${iso}`);
  return ms;
}

/** 以原始偏移量输出（入参是什么偏移就回什么偏移，不做归一化）。 */
export function formatInstant(ms) {
  return new Date(ms).toISOString();
}

export const MINUTE_MS = 60_000;
export const minutesToMs = (minutes) => Math.round(minutes * MINUTE_MS);

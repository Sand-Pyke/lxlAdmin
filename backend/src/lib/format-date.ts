/**
 * match.date 是完整 ISO 字符串，直接渲染会显示成 `2026-09-16T13:39:26.657Z`。
 * 赛事排期统一按北京时间展示，避免服务端运行在 UTC 时将 19:30 错显示为 11:30。
 * 排期时间为可选：空值或解析失败时返回「时间待定」，避免脏数据把页面搞崩。
 */
const matchDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatMatchDate(value: string | null | undefined) {
  if (!value) return '时间待定';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '时间待定';
  const parts = new Map(
    matchDateFormatter
      .formatToParts(d)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')} ${parts.get('hour')}:${parts.get('minute')}`;
}

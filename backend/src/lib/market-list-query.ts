const DAY_MS = 86_400_000;

export function recentMarketDates(now = new Date()): [string, string] {
  const shifted = now.getTime() + 8 * 3_600_000;
  return [
    new Date(shifted - DAY_MS).toISOString().slice(0, 10),
    new Date(shifted).toISOString().slice(0, 10),
  ];
}

export function parseMarketListQuery(query: URLSearchParams, now = new Date()) {
  const positiveInteger = (key: string, fallback: number, max: number) => {
    const value = query.get(key);
    if (value === null) return fallback;
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > max
    )
      throw new Error('分页参数无效');
    return Number(value);
  };
  let dates: [string, string] | null = null;
  if (query.get('range') !== 'all') {
    const start = query.get('startDate'),
      end = query.get('endDate');
    if (start === null && end === null) dates = recentMarketDates(now);
    else {
      for (const date of [start, end]) {
        if (
          !date ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date
        )
          throw new Error('请选择有效的开始和结束日期');
      }
      if (start! > end!) throw new Error('开始日期不能晚于结束日期');
      dates = [start!, end!];
    }
  }
  return {
    page: positiveInteger('page', 1, 1_000_000),
    pageSize: positiveInteger('pageSize', 10, 100),
    createdAt: dates
      ? {
          gte: new Date(`${dates[0]}T00:00:00+08:00`),
          lt: new Date(Date.parse(`${dates[1]}T00:00:00+08:00`) + DAY_MS),
        }
      : undefined,
  };
}

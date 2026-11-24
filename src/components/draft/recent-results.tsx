/** Recent form is supplied newest first by the shared player statistics. */
function recentResults(recent?: string | null) {
  return (recent ?? '')
    .split(/\s+/)
    .filter((result) => result === 'W' || result === 'L')
    .slice(0, 10);
}

export function resultDots(
  recent?: string | null,
  format: 'letters' | 'symbols' | 'form' = 'letters',
) {
  return recentResults(recent).map((result, index) => (
    <span
      key={index}
      className={
        format !== 'letters'
          ? `prof-recent-dot ${result === 'W' ? 'is-win' : 'is-loss'}`
          : `result-dot ${result === 'W' ? 'result-dot--win' : 'result-dot--loss'}`
      }
      title={`最近第 ${index + 1} 场：${result === 'W' ? '胜利' : '失败'}`}
      aria-label={`最近第 ${index + 1} 场：${result === 'W' ? '胜利' : '失败'}`}
    >
      {format === 'symbols' ? (result === 'W' ? '√' : '×') : result}
    </span>
  ));
}

/** 与个人主页一致的 W/L 战绩方块及最近十场统计，左侧为最近一场。 */
export function RecentForm({
  recent,
  className = '',
}: {
  recent?: string | null;
  className?: string;
}) {
  const results = recentResults(recent);
  const wins = results.filter((result) => result === 'W').length;
  const winRate = results.length ? Math.round((wins / results.length) * 100) : 0;
  return (
    <div className={`recent-form ${className}`} title="最多最近 10 场，左侧为最近一场">
      <span className="recent-form-label">最近战绩</span>
      {results.length ? (
        <>
          <div className="prof-recent-dots">{resultDots(recent, 'form')}</div>
          <div className="prof-recent-meta">
            <span>
              近 {results.length} 场 {wins} 胜 {results.length - wins} 负 · 胜率 <b>{winRate}%</b>
            </span>
          </div>
        </>
      ) : (
        <small>暂无战绩</small>
      )}
    </div>
  );
}

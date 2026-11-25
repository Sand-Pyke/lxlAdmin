import { rankIcon } from '../../data/draft-options';

/**
 * 段位展示：图标 + 文字，全站统一用它，避免各处自己拼 img 造成尺寸不一致。
 *
 * - 各页面对空段位的文案不同（未设置 / 未定段 / -），用 fallback 指定。
 * - 没有图标资源（未定段、空串、词表外的段位）时只渲染文字，不留空洞。
 * - 图标尺寸可用 CSS 变量 --rank-icon-size 在各场景微调。
 */
export function RankLabel({
  rank,
  fallback = '未设置',
  className,
  matchBracket = false,
  draftRank,
  iconOnly = false,
}: {
  rank?: string | null;
  fallback?: string;
  className?: string;
  matchBracket?: boolean;
  draftRank?: string | null;
  /** 紧凑场景只展示徽章，段位和降费说明保留在悬停提示中。 */
  iconOnly?: boolean;
}) {
  const icon = rankIcon(rank);
  const label = rank?.trim() || fallback;
  const description = draftRank ? `${label}（使用降费卡当前段位${draftRank}）` : label;
  return (
    <span
      className={`rank-label${iconOnly && icon ? ' rank-label--icon-only' : ''}${className ? ` ${className}` : ''}`}
      title={iconOnly ? description : undefined}
      role={iconOnly && icon ? 'img' : undefined}
      aria-label={iconOnly && icon ? description : undefined}
    >
      {icon ? (
        <img className={matchBracket ? 'match-bracket' : 'rank-icon'} src={icon} alt="" />
      ) : null}
      {iconOnly && icon && (rank?.trim() === '大师+' || rank?.trim() === '钻石+') ? (
        <span className="rank-icon-plus" aria-hidden="true">
          +
        </span>
      ) : null}
      {!iconOnly || !icon ? label : null}
      {!iconOnly && draftRank ? (
        <small className="fee-card-rank-note">（使用降费卡当前段位{draftRank}）</small>
      ) : null}
    </span>
  );
}

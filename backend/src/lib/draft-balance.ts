export type DraftSlot = { teamId: number; position: string };
type DraftTeam = { id: number; fee: number; positions: string[] };
type Candidate = {
  id: number;
  fee: number;
  main: string;
  secondary: string;
  canSubstitute: boolean;
};
type Pick = DraftSlot & { signId: number };

export function balanceDraft(teams: DraftTeam[], candidates: Candidate[], budget: number) {
  const slots = teams.flatMap((team, teamIndex) =>
    team.positions.map((position) => ({
      teamIndex,
      position,
      options: candidates.flatMap((candidate) => {
        const preference =
          candidate.main === position ? 0 : candidate.secondary === position ? 1 : 2;
        return preference < 2 || candidate.canSubstitute
          ? [{ ...candidate, preference, tie: Math.random() }]
          : [];
      }),
    })),
  );
  if (slots.length > candidates.length || slots.some((slot) => !slot.options.length)) return null;
  slots.sort((a, b) => a.options.length - b.options.length);
  const fees = teams.map((team) => team.fee);
  const openSlots = teams.map((team) => team.positions.length);
  const poolAverage =
    candidates.reduce((sum, entry) => sum + entry.fee, 0) / Math.max(1, candidates.length);
  const target =
    (fees.reduce((sum, fee) => sum + fee, 0) + slots.length * poolAverage) / teams.length;
  const taken = new Set<number>();
  const plan: Pick[] = [];
  let best: { plan: Pick[]; gap: number; variance: number; preference: number } | undefined;
  // Bound work while retaining the best complete lineup found.
  let remainingSteps = 40000;
  function search(index: number, preference: number) {
    if (--remainingSteps < 0) return;
    if (index === slots.length) {
      const gap = Math.max(...fees) - Math.min(...fees);
      const sum = fees.reduce((total, fee) => total + fee, 0);
      const variance = teams.length * fees.reduce((total, fee) => total + fee * fee, 0) - sum * sum;
      if (
        !best ||
        gap < best.gap ||
        (gap === best.gap &&
          (variance < best.variance ||
            (variance === best.variance && preference < best.preference)))
      ) {
        best = { plan: [...plan], gap, variance, preference };
      }
      return;
    }
    const { teamIndex, position, options } = slots[index];
    const usedFee = fees[teamIndex];
    openSlots[teamIndex] -= 1;
    const estimate = usedFee + openSlots[teamIndex] * poolAverage;
    const eligible = options.filter(
      (option) => !taken.has(option.id) && usedFee + option.fee <= budget,
    );
    eligible.sort(
      (a, b) =>
        Math.abs(estimate + a.fee - target) - Math.abs(estimate + b.fee - target) ||
        a.preference - b.preference ||
        a.tie - b.tie,
    );
    for (const option of eligible) {
      taken.add(option.id);
      fees[teamIndex] = usedFee + option.fee;
      plan.push({ teamId: teams[teamIndex].id, position, signId: option.id });
      search(index + 1, preference + option.preference);
      plan.pop();
      taken.delete(option.id);
      if (remainingSteps < 0 || (best?.gap === 0 && best.preference === 0)) break;
    }
    fees[teamIndex] = usedFee;
    openSlots[teamIndex] += 1;
  }
  search(0, 0);
  return best ? { picks: best.plan, feeGap: best.gap } : null;
}

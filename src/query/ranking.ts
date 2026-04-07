/**
 * Fuzzy matching and relevance scoring for symbol search.
 */

export interface FuzzyMatch {
  score: number;       // 0–1, higher is better
  matched: boolean;    // passes threshold
}

/**
 * Score how well `query` fuzzy-matches `target`.
 *
 * Scoring rules:
 *  - Exact match → 1.0
 *  - Case-insensitive exact → 0.95
 *  - Starts-with (case-insensitive) → 0.9
 *  - Contains (case-insensitive) → 0.7 + position bonus
 *  - Subsequence match → 0.3–0.6 based on gap penalty
 *  - No match → 0
 */
export function fuzzyScore(query: string, target: string): FuzzyMatch {
  if (query === target) {
    return { score: 1.0, matched: true };
  }

  const qLower = query.toLowerCase();
  const tLower = target.toLowerCase();

  if (qLower === tLower) {
    return { score: 0.95, matched: true };
  }

  if (tLower.startsWith(qLower)) {
    return { score: 0.9, matched: true };
  }

  const idx = tLower.indexOf(qLower);
  if (idx !== -1) {
    // Position bonus: earlier occurrence scores higher
    const posBonus = Math.max(0, 0.15 * (1 - idx / target.length));
    return { score: 0.7 + posBonus, matched: true };
  }

  // Subsequence matching
  const subScore = subsequenceScore(qLower, tLower);
  if (subScore > 0) {
    return { score: subScore, matched: true };
  }

  return { score: 0, matched: false };
}

/**
 * Score a subsequence match. Returns 0 if not a subsequence.
 * Better scores for fewer gaps and consecutive matches.
 */
function subsequenceScore(query: string, target: string): number {
  let qi = 0;
  let consecutiveBonus = 0;
  let totalGaps = 0;
  let lastMatchIdx = -2;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (ti === lastMatchIdx + 1) {
        consecutiveBonus += 0.05;
      } else {
        totalGaps++;
      }
      lastMatchIdx = ti;
      qi++;
    }
  }

  // All query chars must be found
  if (qi < query.length) return 0;

  // Base score 0.3, up to ~0.6 with bonuses
  const gapPenalty = Math.min(totalGaps * 0.05, 0.2);
  const score = 0.3 + consecutiveBonus - gapPenalty;
  return Math.max(0.1, Math.min(score, 0.6));
}

/**
 * Sort results by score descending. Stable for equal scores.
 */
export function rankResults<T extends { _score: number }>(items: T[]): T[] {
  return items.sort((a, b) => b._score - a._score);
}

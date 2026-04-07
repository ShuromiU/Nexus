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
 * Score how well a set of query tokens match across multiple text fields.
 * Each token finds its best match across all fields (weighted).
 * Final score combines average best-per-token score scaled by match ratio.
 *
 * Use for multi-word queries like "project selector tab" where tokens
 * may match different fields (name, path, scope, docstring).
 */
export function multiFieldScore(
  tokens: string[],
  fields: { text: string; weight: number }[],
): FuzzyMatch {
  if (tokens.length === 0) return { score: 0, matched: false };

  let totalBestScore = 0;
  let matchedTokens = 0;

  for (const token of tokens) {
    let bestScore = 0;
    for (const { text, weight } of fields) {
      if (!text) continue;
      const m = fuzzyScore(token, text);
      if (m.matched) {
        const weighted = m.score * weight;
        if (weighted > bestScore) bestScore = weighted;
      }
    }
    if (bestScore > 0) {
      totalBestScore += bestScore;
      matchedTokens++;
    }
  }

  if (matchedTokens === 0) return { score: 0, matched: false };

  const matchRatio = matchedTokens / tokens.length;
  // Require majority of tokens to match for multi-token queries
  if (tokens.length > 1 && matchRatio < 0.5) return { score: 0, matched: false };

  const avgScore = totalBestScore / tokens.length;
  // Scale by sqrt(matchRatio) so partial matches rank lower but aren't excluded
  return { score: avgScore * Math.sqrt(matchRatio), matched: true };
}

/**
 * Split a string on camelCase/PascalCase boundaries, underscores, and hyphens.
 * "fetchUserProfile" → ["fetch", "User", "Profile"]
 * "use_cloud_storage" → ["use", "cloud", "storage"]
 */
function tokenize(str: string): string[] {
  return str
    .split(/(?=[A-Z])|[_\-\s]+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

/**
 * Generate "did you mean?" suggestions from a list of candidate names.
 *
 * Strategy (in priority order):
 *  1. Direct fuzzyScore match (relaxed threshold)
 *  2. camelCase-tokenized query — match individual tokens against names
 */
export function getSuggestions(
  query: string,
  candidates: string[],
  limit = 5,
): string[] {
  const seen = new Set<string>();
  const scored: { name: string; score: number }[] = [];

  // Deduplicate candidates
  const unique: string[] = [];
  for (const name of candidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }

  const words = query.trim().split(/\s+/);

  // Pass 1: direct fuzzy matching (relaxed threshold)
  for (const name of unique) {
    if (words.length === 1) {
      const m = fuzzyScore(words[0], name);
      if (m.score >= 0.15) {
        scored.push({ name, score: m.score });
      }
    } else {
      let bestScore = 0;
      for (const word of words) {
        const m = fuzzyScore(word, name);
        if (m.matched && m.score > bestScore) bestScore = m.score;
      }
      if (bestScore >= 0.15) {
        scored.push({ name, score: bestScore });
      }
    }
  }

  // Pass 2: if pass 1 found nothing, try camelCase tokenization
  if (scored.length === 0) {
    // Tokenize all words and flatten
    const queryTokens = words.flatMap(w => tokenize(w)).filter(t => t.length >= 3);

    if (queryTokens.length > 0) {
      for (const name of unique) {
        let bestScore = 0;
        for (const token of queryTokens) {
          const m = fuzzyScore(token, name);
          if (m.matched && m.score > bestScore) bestScore = m.score;
        }
        if (bestScore >= 0.4) {
          // Discount since we're matching fragments, not the full query
          scored.push({ name, score: bestScore * 0.7 });
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.name);
}

/**
 * Sort results by score descending. Stable for equal scores.
 */
export function rankResults<T extends { _score: number }>(items: T[]): T[] {
  return items.sort((a, b) => b._score - a._score);
}

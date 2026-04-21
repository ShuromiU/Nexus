export interface ParsedYarnLock {
  entries: { name: string; version: string }[];
}

export type ParseError = { error: string };

/**
 * Minimal yarn v1 lockfile parser. Pulls name + resolved version from each
 * block. Good enough for A3's lockfile_deps tool; not a full grammar.
 */
export function parseYarnLock(content: string): ParsedYarnLock | ParseError {
  const entries: { name: string; version: string }[] = [];

  // A block starts at column 0 with a spec line that ends in ':', and contains
  // a `  version "<v>"` line somewhere in its body. We walk lines to find
  // spec→version pairs.
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith('#') || line.startsWith(' ')) {
      i++;
      continue;
    }
    if (!line.endsWith(':')) {
      i++;
      continue;
    }

    const firstSpec = extractFirstSpec(line.slice(0, -1));
    if (!firstSpec) {
      i++;
      continue;
    }

    // Scan body for version.
    let version: string | null = null;
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith(' ') || lines[j].length === 0)) {
      const m = /^\s+version\s+"([^"]+)"/.exec(lines[j]);
      if (m) {
        version = m[1];
        break;
      }
      j++;
    }

    if (version !== null) {
      entries.push({ name: firstSpec, version });
    }
    i = j;
  }

  return { entries };
}

/**
 * A spec line can be a single quoted spec or a comma-separated list:
 *   "react@^18.0.0"
 *   "lodash@^4.17.0", "lodash@^4.17.21"
 *   react@^18.0.0
 * We extract the package name from the first spec only.
 */
function extractFirstSpec(specLine: string): string | null {
  const first = specLine.split(',')[0].trim();
  // Strip surrounding quotes.
  const unquoted = first.startsWith('"') && first.endsWith('"')
    ? first.slice(1, -1)
    : first;
  // Name is everything up to the last `@` that isn't the leading scope `@`.
  // For scoped packages (`@scope/name@range`) the package name is `@scope/name`.
  if (unquoted.startsWith('@')) {
    const slashIdx = unquoted.indexOf('/');
    if (slashIdx === -1) return null;
    const atAfterName = unquoted.indexOf('@', slashIdx);
    return atAfterName === -1 ? unquoted : unquoted.slice(0, atAfterName);
  }
  const atIdx = unquoted.indexOf('@');
  return atIdx <= 0 ? unquoted : unquoted.slice(0, atIdx);
}

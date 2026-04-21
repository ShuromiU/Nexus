import { parse as parseToml } from 'smol-toml';

export type ParseError = { error: string };

export function parseGenericToml(content: string): unknown | ParseError {
  try {
    return parseToml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid TOML' };
  }
}

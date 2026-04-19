import { parse as parseYaml } from 'yaml';

export type ParseError = { error: string };

export function parseGenericYaml(content: string): unknown | ParseError {
  try {
    return parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
}

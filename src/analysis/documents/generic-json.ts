import { parse as parseJsonc, ParseError as JsoncParseError } from 'jsonc-parser';

export type ParseError = { error: string };

export function parseGenericJson(content: string): unknown | ParseError {
  const errors: JsoncParseError[] = [];
  const raw = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { error: `JSON parse error (${errors.length})` };
  }
  return raw;
}

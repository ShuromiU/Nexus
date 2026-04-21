import { parse as parseJsonc, ParseError as JsoncParseError } from 'jsonc-parser';

export interface ParsedTsconfig {
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: { path: string }[];
}

export type ParseError = { error: string };

export function parseTsconfig(content: string): ParsedTsconfig | ParseError {
  const errors: JsoncParseError[] = [];
  const raw = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return { error: `tsconfig JSONC parse error (${errors.length})` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'tsconfig root must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedTsconfig = {};
  if (typeof obj.extends === 'string') result.extends = obj.extends;
  else if (Array.isArray(obj.extends) && obj.extends.every(x => typeof x === 'string')) {
    result.extends = obj.extends as string[];
  }
  if (typeof obj.compilerOptions === 'object' && obj.compilerOptions !== null && !Array.isArray(obj.compilerOptions)) {
    result.compilerOptions = obj.compilerOptions as Record<string, unknown>;
  }
  if (Array.isArray(obj.include) && obj.include.every(x => typeof x === 'string')) {
    result.include = obj.include as string[];
  }
  if (Array.isArray(obj.exclude) && obj.exclude.every(x => typeof x === 'string')) {
    result.exclude = obj.exclude as string[];
  }
  if (Array.isArray(obj.files) && obj.files.every(x => typeof x === 'string')) {
    result.files = obj.files as string[];
  }
  if (Array.isArray(obj.references)) {
    const refs: { path: string }[] = [];
    for (const r of obj.references) {
      if (typeof r === 'object' && r !== null && typeof (r as { path?: unknown }).path === 'string') {
        refs.push({ path: (r as { path: string }).path });
      }
    }
    if (refs.length > 0) result.references = refs;
  }
  return result;
}

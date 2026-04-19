import { parse as parseYaml } from 'yaml';

export interface ParsedGhaWorkflow {
  name?: string;
  on?: unknown;
  jobs?: Record<string, {
    'runs-on'?: string | string[];
    steps?: {
      name?: string;
      uses?: string;
      run?: string;
    }[];
  }>;
}

export type ParseError = { error: string };

export function parseGhaWorkflow(content: string): ParsedGhaWorkflow | ParseError {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid YAML' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'workflow root must be a mapping' };
  }
  const obj = raw as Record<string, unknown>;
  const result: ParsedGhaWorkflow = {};
  if (typeof obj.name === 'string') result.name = obj.name;
  if ('on' in obj) result.on = obj.on;
  if (typeof obj.jobs === 'object' && obj.jobs !== null && !Array.isArray(obj.jobs)) {
    const jobs: NonNullable<ParsedGhaWorkflow['jobs']> = {};
    for (const [jobId, jobRaw] of Object.entries(obj.jobs as Record<string, unknown>)) {
      if (typeof jobRaw !== 'object' || jobRaw === null || Array.isArray(jobRaw)) continue;
      const j = jobRaw as Record<string, unknown>;
      const job: NonNullable<ParsedGhaWorkflow['jobs']>[string] = {};
      if (typeof j['runs-on'] === 'string') job['runs-on'] = j['runs-on'] as string;
      else if (Array.isArray(j['runs-on']) && (j['runs-on'] as unknown[]).every(x => typeof x === 'string')) {
        job['runs-on'] = j['runs-on'] as string[];
      }
      if (Array.isArray(j.steps)) {
        const steps: NonNullable<NonNullable<ParsedGhaWorkflow['jobs']>[string]['steps']> = [];
        for (const s of j.steps as unknown[]) {
          if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
          const step = s as Record<string, unknown>;
          const item: { name?: string; uses?: string; run?: string } = {};
          if (typeof step.name === 'string') item.name = step.name;
          if (typeof step.uses === 'string') item.uses = step.uses;
          if (typeof step.run === 'string') item.run = step.run;
          steps.push(item);
        }
        job.steps = steps;
      }
      jobs[jobId] = job;
    }
    result.jobs = jobs;
  }
  return result;
}

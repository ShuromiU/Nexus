import type { PolicyRule } from '../types.js';

const NON_CODE_EXT = /\.(md|json|yaml|yml|toml|env|lock|txt|csv|html|xml|sql|sh|bat|cmd|log)$/i;
const NON_CODE_TYPE = /^(md|json|yaml|yml|toml)$/i;
const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;

const DENY_REASON =
  'NEXUS ONLY: Use nexus_find, nexus_refs, nexus_search, or nexus_grep instead of Grep for code files. Grep is NOT allowed for code — use Nexus.';

export const grepOnCodeRule: PolicyRule = {
  name: 'grep-on-code',
  evaluate(event) {
    if (event.tool_name !== 'Grep') return null;

    const input = event.tool_input;
    const glob = typeof input.glob === 'string' ? input.glob : '';
    const type = typeof input.type === 'string' ? input.type : '';
    const searchPath = typeof input.path === 'string' ? input.path : '';

    if (glob && NON_CODE_EXT.test(glob)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code glob' };
    }
    if (type && NON_CODE_TYPE.test(type)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code type' };
    }
    if (searchPath && NON_CODE_PATH.test(searchPath)) {
      return { decision: 'allow', rule: 'grep-on-code', reason: 'non-code path' };
    }

    return { decision: 'deny', rule: 'grep-on-code', reason: DENY_REASON };
  },
};

/**
 * Path fragments that are not "code" for the purpose of policy rules.
 * Shared between grep-on-code and read-on-source. Matches are substring-based
 * (case-insensitive) — path need not start with the fragment.
 */
export const NON_CODE_PATH = /(node_modules|\.git|\.nexus|\/?docs\/|\.env|\.claude\/)/i;

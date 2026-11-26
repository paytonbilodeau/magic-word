// The brand the tests run against (vitest.config.ts points every `./brand` import here), so filling in src/brand.ts
// with your own account never breaks the suite.

export const ORIGIN = "https://magic-word.example.workers.dev";
export const IG_HANDLE = "yourhandle";
export const BUSINESS = "Example LLC";
export const SITE = "example.com";
export const CONTACT_EMAIL = "you@example.com";
export const COMMUNITY = "Your Community";
export const SKOOL_GROUPS = ["your-community"];

export const LINK_RE = new RegExp(`skool\\.com\\/(${SKOOL_GROUPS.join("|")})|\\/l\\/`, "i");
export const skoolLinkSql = (col: string) => SKOOL_GROUPS.map((g) => `instr(${col}, 'skool.com/${g}') > 0`).join(" OR ");

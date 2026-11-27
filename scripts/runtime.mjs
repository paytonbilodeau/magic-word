// Self-host the same Worker handler using Node HTTP and a persistent SQLite file.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { openStore } from './storage.mjs';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
export const live = process.argv.includes('--live');
export const port = Number(process.env.PORT || 8791);
export const bind = process.env.MAGICWORD_BIND || '127.0.0.1';
export const origin = live ? process.env.MAGICWORD_PUBLIC_URL : 'http://127.0.0.1:' + port;
if (!origin || (live && !/^https:\/\/[^/?#]+$/.test(origin)))
  throw Error('Set MAGICWORD_PUBLIC_URL to the public HTTPS origin.');
if (!live && bind !== '127.0.0.1') throw Error('The demo listens only on 127.0.0.1.');
const data = resolve(process.env.MAGICWORD_DATA_DIR || join(root, '.magic-word'), live ? 'live' : 'demo');
mkdirSync(data, { recursive: true, mode: 0o700 });
export const secretFile = join(data, 'credentials.json');
if (!existsSync(secretFile)) {
  const random = () => randomBytes(32).toString('hex');
  const temp = secretFile + '.' + process.pid + '.tmp';
  writeFileSync(
    temp,
    JSON.stringify({
      ADMIN_PASSWORD: random(),
      META_VERIFY_TOKEN: random(),
      INBOUND_SECRET: random(),
      SESSION_SECRET: random(),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  try {
    linkSync(temp, secretFile);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    unlinkSync(temp);
  }
}
const secrets = JSON.parse(readFileSync(secretFile, 'utf8'));
const config = live ? process.env : {};
if (live && (!config.MAGICWORD_BUSINESS || !config.MAGICWORD_CONTACT_EMAIL)) {
  throw Error('Set the operator name and public contact email. See docs/SELF-HOST.md.');
}
const instagram = Boolean(config.META_IG_APP_ID || config.META_APP_SECRET || config.MAGICWORD_IG_HANDLE);
if (
  live &&
  instagram &&
  (!config.META_IG_APP_ID ||
    !config.META_APP_SECRET ||
    !/^[a-z\d._]{1,30}$/i.test(config.MAGICWORD_IG_HANDLE || ''))
) {
  throw Error('Instagram needs its account handle, app ID and app secret.');
}
const brands = {
  ORIGIN: origin,
  IG_HANDLE: config.MAGICWORD_IG_HANDLE || (live ? 'owner' : 'demo'),
  BUSINESS: config.MAGICWORD_BUSINESS || 'Demo',
  SITE: config.MAGICWORD_SITE || new URL(origin).host,
  CONTACT_EMAIL: config.MAGICWORD_CONTACT_EMAIL || 'demo@example.invalid',
  COMMUNITY: config.MAGICWORD_COMMUNITY || 'community',
};
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const brandContents =
  Object.entries(brands)
    .map(
      ([k, v]) =>
        'export const ' +
        k +
        '=' +
        JSON.stringify(['BUSINESS', 'SITE', 'CONTACT_EMAIL', 'COMMUNITY'].includes(k) ? escapeHtml(v) : v) +
        ';',
    )
    .join('\n') +
  '\nexport const SKOOL_GROUPS=[];export const LINK_RE=/\\/l\\//i;export const skoolLinkSql=()=>"0";';
const bundle = join(root, '.magic-word', (live ? 'app-' : 'demo-') + process.pid + '.mjs');
mkdirSync(dirname(bundle), { recursive: true });
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: bundle,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'host-brand',
      setup(ctx) {
        ctx.onResolve({ filter: /^\.\/brand$/ }, () => ({ path: 'brand', namespace: 'host' }));
        ctx.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: brandContents }));
      },
    },
  ],
});
export const worker = (await import(pathToFileURL(bundle).href)).default;
unlinkSync(bundle);
export const db = openStore(
  join(data, 'inbox.sqlite'),
  live
    ? null
    : () =>
        execFileSync(process.execPath, [join(root, 'scripts/preview-seed.mjs')], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        }),
);
export const env = {
  ...secrets,
  DB: db,
  AUTOPILOT: 'false',
  TYPING: 'false',
  TRANSPORT: 'meta',
  SKOOL_LINK: config.MAGICWORD_LINK || 'https://example.com/guide',
  META_APP_SECRET: config.META_APP_SECRET || (live ? '' : secrets.SESSION_SECRET),
  META_IG_APP_ID: config.META_IG_APP_ID || '',
  ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY || '',
  MANYCHAT_API_KEY: config.MANYCHAT_API_KEY || '',
  REVIEW_PASSWORD: config.REVIEW_PASSWORD || '',
  REPLY_DELAY_MIN_S: '2',
  REPLY_DELAY_MAX_S: '5',
  HOST_MODE: live ? 'live' : 'demo',
};
for (const key of [
  'YOUTUBE_CHANNEL_ID',
  'YOUTUBE_DATA_API_KEY',
  'TG_BOT_TOKEN',
  'TG_WEBHOOK_SECRET',
  'CHANNEL_META_SECRET',
  'CHANNEL_VERIFY_TOKEN',
  'FB_PAGE_ID',
  'FB_PAGE_TOKEN',
  'WA_PHONE_ID',
  'WA_TOKEN',
])
  if (config[key]) env[key] = config[key];
if (!live)
  globalThis.fetch = async () => {
    throw Error('External requests are disabled in the local demo.');
  };
export const pending = new Set();
export const ctx = {
  waitUntil(p) {
    const job = Promise.resolve(p)
      .catch(() => console.error('Background task failed.'))
      .finally(() => pending.delete(job));
    pending.add(job);
  },
};

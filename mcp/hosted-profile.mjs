// A checkout can explicitly point its installed stdio clients at the owner's deployment.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export const profileFile = fileURLToPath(new URL('../.magic-word/hosted.json', import.meta.url));

export function hostedCredentials(path = profileFile) {
  if (!existsSync(path)) return null;
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) throw Error('Make the hosted profile owner-only.');
  const profile = JSON.parse(readFileSync(path, 'utf8'));
  const service = new URL(profile.url);
  if (service.protocol !== 'https:' || service.href !== service.origin + '/')
    throw Error('Invalid hosted origin.');
  if (process.platform !== 'win32' && statSync(profile.envFile).mode & 0o077)
    throw Error('Make the credentials file owner-only.');
  const secrets = parseEnv(readFileSync(profile.envFile, 'utf8'));
  if (!secrets.ADMIN_PASSWORD || !secrets.MAGICWORD_MCP_TOKEN)
    throw Error('The hosted credentials file is incomplete.');
  return {
    url: service.origin,
    password: secrets.ADMIN_PASSWORD,
    token: secrets.MAGICWORD_MCP_TOKEN,
    composio: profile.composio,
  };
}

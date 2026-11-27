import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hostedCredentials, profileFile } from '../mcp/hosted-profile.mjs';

const config = JSON.parse(readFileSync(new URL('../magic-word.config.json', import.meta.url), 'utf8'));
if (!config.url) throw Error('Deploy the Worker with npm run setup first.');
const profile = { url: config.url, envFile: fileURLToPath(new URL('../.env', import.meta.url)) };
if (process.argv.includes('--composio')) {
  const command = process.env.COMPOSIO_BIN || 'composio';
  if (command !== 'composio' && !isAbsolute(command)) throw Error('Set COMPOSIO_BIN to an absolute path.');
  const accounts = {};
  for (const channel of ['instagram', 'youtube']) {
    const rows =
      JSON.parse(
        execFileSync(command, ['connections', 'list', '--toolkit', channel], {
          encoding: 'utf8',
          timeout: 30000,
        }),
      )[channel] || [];
    const selector = process.env['MAGICWORD_' + channel.toUpperCase() + '_CONNECTION'];
    const active = rows.filter(
      (row) => row.status === 'ACTIVE' && (!selector || [row.id, row.alias, row.word_id].includes(selector)),
    );
    if (active.length > 1)
      throw Error(
        'Select a single ' + channel + ' connection with MAGICWORD_' + channel.toUpperCase() + '_CONNECTION.',
      );
    if (selector && !active.length) throw Error('The selected ' + channel + ' connection is unavailable.');
    if (active.length) accounts[channel] = active[0].id;
  }
  if (!Object.keys(accounts).length) throw Error('No active Instagram or YouTube connections.');
  if (accounts.instagram) {
    const me = JSON.parse(
      execFileSync(
        command,
        [
          'proxy',
          'https://graph.instagram.com/v26.0/me?fields=username',
          '--toolkit',
          'instagram',
          '--account',
          accounts.instagram,
        ],
        { encoding: 'utf8', timeout: 30000 },
      ),
    );
    if (!config.instagram_handle || me.username?.toLowerCase() !== config.instagram_handle.toLowerCase())
      throw Error('The connected Instagram account does not match the configured handle.');
  }
  profile.composio = { command, accounts, instagramHandle: config.instagram_handle };
}
mkdirSync(dirname(profileFile), { recursive: true, mode: 0o700 });
const temp = profileFile + '.' + randomUUID();
const client = new Client({ name: 'magic-word-setup', version: '1' });
try {
  writeFileSync(temp, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
  const { url, token } = hostedCredentials(temp);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
    }),
  );
  const tools = await client.listTools();
  const status = await client.callTool({ name: 'status', arguments: {} });
  if (status.isError || JSON.parse(status.content[0].text).mode !== 'worker')
    throw Error('Could not verify production.');
  renameSync(temp, profileFile);
  console.log(
    'Connected to ' + url + '/mcp. Verified ' + tools.tools.length + ' tools. Open a new AI session.',
  );
} finally {
  await client.close();
  rmSync(temp, { force: true });
}

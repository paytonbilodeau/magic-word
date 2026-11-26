import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { installConfig, installCLI } from '../scripts/setup-ai.mjs';

test('installs once, preserves commented client settings and refuses conflicting registrations', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'magic-word-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'mcp.json');
  writeFileSync(file, '{\n // personal settings\n "mcpServers":{"other":{"command":"my-tool"}},\n}\n');
  assert.equal(installConfig(file), 'registered');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('// personal settings'));
  assert.equal(parse(text).mcpServers.other.command, 'my-tool');
  assert.equal(installConfig(file), 'already connected');
  assert.equal(readFileSync(file, 'utf8'), text);
  for (const broken of ['{bad', '{"mcpServers":{"magic-word":{"command":"elsewhere"}}}']) {
    writeFileSync(file, broken);
    assert.throws(() => installConfig(file));
    assert.equal(readFileSync(file, 'utf8'), broken);
  }
});

for (const client of ['codex', 'claude']) {
  test(client + ' registers a fresh client entry and verifies repeat setup without another write', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'magic-word-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'client');
    const state = join(dir, 'registered.json');
    const code = `#!${process.execPath}
const fs=require('node:fs'), file=${JSON.stringify(state)}, args=process.argv.slice(2);
if(args[1]==='get'){
  if(!fs.existsSync(file)){console.error('No MCP server named magic-word.'); process.exit(1);}
  const pair=JSON.parse(fs.readFileSync(file,'utf8'));
  if(${JSON.stringify(client)}==='claude')console.log('Command: '+pair.command+'\\nArgs: '+pair.args[0]);
  else console.log(JSON.stringify({enabled:true,transport:pair}));
} else if(args[1]==='add'){
  if(fs.existsSync(file))process.exit(2);
  fs.writeFileSync(file,JSON.stringify({command:args.at(-2),args:[args.at(-1)]}));
} else process.exit(2);
`;
    writeFileSync(bin, code, { mode: 0o700 });
    assert.equal(installCLI(client, bin), 'registered');
    assert.equal(installCLI(client, bin), 'already connected');
  });
}

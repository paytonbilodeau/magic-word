// Register a single, local MCP server without touching other client settings.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits, modify, parse } from 'jsonc-parser';

const script = fileURLToPath(new URL('../mcp/stdio.mjs', import.meta.url));
const example = fileURLToPath(new URL('../examples/comment-to-dm.mjs', import.meta.url));
const serverName = 'magic-word';
const sameFile = (a, b) => {
  if (a === b) return true;
  try {
    return isAbsolute(a) && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const executable =
  (process.env.PATH || '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => join(dir, nodeName))
    .find((path) => sameFile(path, process.execPath)) ?? process.execPath;
const spec = { command: executable, args: [script] };
const configEntry = { mcpServers: { [serverName]: spec } };
const matches = (entry) =>
  sameFile(entry?.command, spec.command) &&
  Array.isArray(entry.args) &&
  entry.args.length === 1 &&
  entry.args[0] === script;
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
function findCLI(client) {
  const paths = [client, join(homedir(), '.local', 'bin', client)];
  if (client === 'codex' && process.platform === 'darwin')
    paths.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  return paths.find((path) => run(path, ['--version']).status === 0);
}
export function installCLI(client, bin) {
  const get = ['mcp', 'get', serverName, ...(client === 'codex' ? ['--json'] : [])];
  function current() {
    const result = run(bin, get);
    if (result.status === 0) {
      if (client === 'codex') {
        const entry = JSON.parse(result.stdout);
        return matches(entry.transport) && entry.enabled !== false;
      }
      const lines = result.stdout.split(/\r?\n/).map((s) => s.trim());
      return (
        sameFile(lines.find((line) => line.startsWith('Command: '))?.slice(9), spec.command) &&
        lines.includes('Args: ' + script)
      );
    }
    if (/No MCP server (named|found)/i.test(result.stdout + result.stderr)) return null;
    throw Error('Could not read ' + client + ' MCP settings. Existing settings were preserved.');
  }
  const before = current();
  if (before === true) return 'already connected';
  if (before === false)
    throw Error(
      client +
        ' already has an entry named magic-word with another configuration. Choose which checkout to use before replacing it.',
    );
  const args =
    client === 'codex'
      ? ['mcp', 'add', serverName, '--', spec.command, script]
      : ['mcp', 'add', '-s', 'user', '--', serverName, spec.command, script];
  if (run(bin, args).status !== 0 || current() !== true)
    throw Error('Could not verify the ' + client + ' registration.');
  return 'registered';
}
export function installConfig(path) {
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const original = read();
  const errors = [];
  const obj = parse(original ?? '{}', errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !obj ||
    typeof obj !== 'object' ||
    Array.isArray(obj) ||
    (obj.mcpServers != null && (typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers)))
  )
    throw Error('Unrecognized MCP configuration. Existing file was preserved.');
  const existing = obj.mcpServers?.[serverName];
  if (existing) {
    if (!matches(existing)) throw Error('A different magic-word registration already exists.');
    return 'already connected';
  }
  const base = original ?? '{}\n';
  const edits = modify(base, ['mcpServers', serverName], spec, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const updated = applyEdits(base, edits);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, updated, { mode: 0o600, flag: 'wx' });
  try {
    if (read() !== original) throw Error('Client settings changed during setup. Rerun setup.');
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return 'registered';
}
export function setup(argv) {
  if (
    argv.length &&
    (argv.length !== 2 ||
      argv[0] !== '--client' ||
      !['codex', 'claude', 'cursor', 'gemini', 'json', 'auto'].includes(argv[1]))
  )
    throw Error('Use --client codex, claude, cursor, gemini, json or auto.');
  const chosen = argv[1] ?? 'auto';
  const proof = run(process.execPath, [example]);
  if (proof.status !== 0)
    throw Error('The offline example failed. Run npm ci and npm run example for details.');
  console.log(proof.stdout.trim());
  let count = 0;
  for (const client of ['codex', 'claude']) {
    if (chosen !== 'auto' && chosen !== client) continue;
    const bin = findCLI(client);
    if (!bin) {
      if (chosen === client)
        throw Error(client + ' CLI was unavailable. Use --client json for its server configuration.');
      continue;
    }
    console.log(client + ': ' + installCLI(client, bin));
    count++;
  }
  for (const [client, dir, file] of [
    ['cursor', '.cursor', 'mcp.json'],
    ['gemini', '.gemini', 'settings.json'],
  ]) {
    if (chosen !== client) continue;
    console.log(client + ': ' + installConfig(join(homedir(), dir, file)));
    count++;
  }
  if (!count)
    console.log('Use this local MCP entry in your client:\n' + JSON.stringify(configEntry, null, 2));
  else console.log('Open a new AI session and ask Magic Word for its status.');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    setup(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

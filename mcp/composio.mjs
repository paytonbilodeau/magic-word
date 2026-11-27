import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { socialRead } from '../src/social-reads.ts';
const execute = promisify(execFile);

// Each selected connection is private to this checkout. No Composio credential is sent to the host.
export function withComposio(call, cfg) {
  const allowed = new Set([
    'instagram_live_media',
    'instagram_live_comments',
    'instagram_live_inbox',
    'youtube_comments',
  ]);
  return async (path, options = {}) => {
    const view = path.slice('/admin/api/'.length);
    const channel = view.startsWith('instagram_') ? 'instagram' : 'youtube';
    if (
      !path.startsWith('/admin/api/') ||
      !allowed.has(view) ||
      !cfg.accounts?.[channel] ||
      (options.method || 'GET') !== 'GET'
    )
      return call(path, options);
    // Prefer the cloud account. A missing credential is the only reason to consult this machine.
    try {
      return await call(path, options);
    } catch (error) {
      if (!/^Console HTTP 409/.test(error.message)) throw error;
    }
    const request = async (toolkit, url) => {
      let stdout;
      try {
        ({ stdout } = await execute(
          cfg.command,
          ['proxy', url.href, '--toolkit', toolkit, '--account', cfg.accounts[toolkit]],
          { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        ));
      } catch {
        throw Error('Composio could not reach the selected ' + toolkit + ' account.');
      }
      const res = JSON.parse(stdout);
      if (res.error) {
        const reason = String(res.error.errors?.[0]?.reason || res.error.code || 'request_rejected');
        throw Error(toolkit + ' provider error: ' + reason.replace(/[^a-z\d_-]/gi, '').slice(0, 80));
      }
      return res;
    };
    if (channel === 'instagram') {
      const me = await request(channel, new URL('https://graph.instagram.com/v26.0/me?fields=username'));
      if (!cfg.instagramHandle || me.username?.toLowerCase() !== cfg.instagramHandle.toLowerCase())
        throw Error('The selected Instagram connection does not match this installation’s owner.');
    }
    return socialRead(request, view, options.query?.limit || 10, options.query?.media);
  };
}

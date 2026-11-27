import { expect, it, vi, afterEach } from 'vitest';
import { youtubeRead } from '../src/youtube';
import type { Env } from '../src/setter';

const owner = 'UC' + 'A'.repeat(22);
const env = { YOUTUBE_CHANNEL_ID: owner } as Env;
afterEach(() => vi.unstubAllGlobals());

it('reads the owner feed and rejects a feed from another channel', async () => {
  const feed = (id: string) =>
    new Response(
      '<feed><yt:channelId>' +
        id +
        '</yt:channelId><entry><yt:videoId>abcdefghijk</yt:videoId><title>Example &amp; demo</title></entry></feed>',
    );
  const provider = vi
    .fn()
    .mockResolvedValueOnce(feed(owner.slice(2)))
    .mockResolvedValueOnce(feed('other'));
  vi.stubGlobal('fetch', provider);
  expect(await (await youtubeRead(env, 'youtube_videos', 1)).json()).toMatchObject({
    channel: owner,
    videos: [{ id: 'abcdefghijk', title: 'Example & demo' }],
  });
  expect((await youtubeRead(env, 'youtube_videos', 1)).status).toBe(502);
});
it('requires a channel and a scoped key for remote Google comment reads', async () => {
  expect((await youtubeRead({} as Env, 'youtube_videos', 1)).status).toBe(409);
  expect((await youtubeRead(env, 'youtube_comments', 1)).status).toBe(409);
  const provider = vi.fn().mockResolvedValue(Response.json({ items: [] }));
  vi.stubGlobal('fetch', provider);
  const result = await youtubeRead({ ...env, YOUTUBE_DATA_API_KEY: 'test-key' }, 'youtube_comments', 1);
  expect(await result.json()).toEqual({ channel: owner, comments: [] });
  expect(provider.mock.calls[0][0].searchParams.get('allThreadsRelatedToChannelId')).toBe(owner);
  expect(provider.mock.calls[0][1].headers['X-Goog-Api-Key']).toBe('test-key');
});

import { expect, it, vi } from 'vitest';
import { socialRead } from '../src/social-reads';

it('restricts live comments to posts owned by the connected account', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce({ username: 'owner' })
    .mockResolvedValueOnce({ username: 'other' });
  await expect(socialRead(api, 'instagram_live_comments', 1, '42')).rejects.toThrow('belong');
  expect(api).toHaveBeenCalledTimes(2);
  await expect(socialRead(api, 'instagram_live_comments', 1, '/me')).rejects.toThrow('numeric');
  expect(api).toHaveBeenCalledTimes(2);
});
it('returns only the requested Instagram data, dropping private paging URLs', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce({ username: 'owner' })
    .mockResolvedValueOnce({ username: 'owner' })
    .mockResolvedValueOnce({ data: [{ id: '1', text: 'example' }], paging: { next: 'private' } });
  expect(await socialRead(api, 'instagram_live_comments', 100, '42')).toEqual({
    media: '42',
    comments: [{ id: '1', text: 'example' }],
    source: 'instagram',
  });
  expect(api.mock.calls[2][1].searchParams.get('limit')).toBe('50');
});
it('allows YouTube comment reads only on the authenticated creator channel', async () => {
  const channel = 'UC' + 'A'.repeat(22);
  const api = vi
    .fn()
    .mockResolvedValueOnce({ items: [{ id: channel }] })
    .mockResolvedValueOnce({ items: [{ snippet: { channelId: 'other' } }] });
  expect(await socialRead(api, 'youtube_comments', 1)).toEqual({ channel, comments: [] });
  expect(api.mock.calls[1][1].searchParams.get('allThreadsRelatedToChannelId')).toBe(channel);
});

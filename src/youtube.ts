import { DOMParser } from 'linkedom';
import type { Env } from './setter';

const channelId = /^UC[A-Za-z0-9_-]{22}$/;
const xmlNamespace = 'text/xml';
type Thread = {
  id: string;
  snippet: {
    channelId: string;
    videoId?: string;
    topLevelComment: { id: string; snippet: { textDisplay: string; publishedAt: string } };
  };
};

export async function youtubeRead(env: Env, view: string, limit: number): Promise<Response> {
  const channel = env.YOUTUBE_CHANNEL_ID || '';
  const fail = (error: string, status: number) => Response.json({ error }, { status });
  if (!channelId.test(channel)) return fail('Set YOUTUBE_CHANNEL_ID to the owner’s public channel ID.', 409);
  if (view === 'youtube_videos') {
    const reply = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + channel, {
      signal: AbortSignal.timeout(10000),
    });
    if (!reply.ok) return fail('YouTube feed returned HTTP ' + reply.status, 502);
    const feed = new DOMParser().parseFromString(await reply.text(), xmlNamespace);
    const feedChannel = feed.getElementsByTagName('yt:channelId')[0]?.textContent;
    if (feedChannel !== channel && feedChannel !== channel.slice(2))
      return fail('The feed did not identify the configured channel.', 502);
    const entries = Array.from(feed.getElementsByTagName('entry'))
      .slice(0, limit)
      .map((entry) => {
        const field = (name: string) => entry.getElementsByTagName(name)[0]?.textContent || '';
        const id = field('yt:videoId');
        return {
          id,
          title: field('title'),
          published: field('published'),
          url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
        };
      });
    return Response.json({ channel, videos: entries });
  }
  if (!env.YOUTUBE_DATA_API_KEY)
    return fail(
      'Set a YouTube Data API key restricted to this application, or use the local Composio connection.',
      409,
    );
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.search = new URLSearchParams({
    allThreadsRelatedToChannelId: channel,
    part: 'snippet',
    maxResults: String(limit),
    order: 'time',
    textFormat: 'plainText',
    fields: 'items(id,snippet(channelId,videoId,topLevelComment(id,snippet(textDisplay,publishedAt))))',
  }).toString();
  const reply = await fetch(url, {
    headers: { 'X-Goog-Api-Key': env.YOUTUBE_DATA_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!reply.ok)
    return fail('YouTube Data API returned HTTP ' + reply.status + '. Check quota and API access.', 502);
  const data = await reply.json<{ items: Thread[] }>();
  return Response.json({
    channel,
    comments: data.items
      .filter((row) => row.snippet.channelId === channel)
      .map((row) => ({
        id: row.snippet.topLevelComment.id,
        video: row.snippet.videoId,
        text: row.snippet.topLevelComment.snippet.textDisplay,
        published: row.snippet.topLevelComment.snippet.publishedAt,
      })),
  });
}

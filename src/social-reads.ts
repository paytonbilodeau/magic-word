// All requests originate here, including calls made by the optional local Composio adapter.
type Json = Record<string, any>;
export type SocialRequest = (channel: 'instagram' | 'youtube', url: URL) => Promise<Json>;
export async function socialRead(request: SocialRequest, view: string, limit: number, media?: string) {
  const size = String(Math.max(1, Math.min(50, Math.floor(limit) || 10)));
  const ig = (path: string, query: Record<string, string>) => {
    const url = new URL('https://graph.instagram.com/v26.0/' + path);
    url.search = new URLSearchParams(query).toString();
    return request('instagram', url);
  };
  if (view === 'instagram_live_inbox') {
    const result = await ig('me/conversations', {
      platform: 'instagram',
      fields: 'id,updated_time',
      limit: size,
    });
    return { conversations: result.data, source: 'instagram' };
  }
  if (view === 'instagram_live_media') {
    const result = await ig('me/media', { fields: 'id,caption,permalink,timestamp,media_type', limit: size });
    return { media: result.data, source: 'instagram' };
  }
  if (view === 'instagram_live_comments') {
    if (!media || !/^\d{1,30}$/.test(media))
      throw Error('Supply a numeric media ID from instagram_live_media.');
    const profile = await ig('me', { fields: 'username' });
    const post = await ig(media, { fields: 'username' });
    if (!profile.username || post.username !== profile.username)
      throw Error('This post does not belong to the connected account.');
    const result = await ig(media + '/comments', { fields: 'id,text,timestamp,username', limit: size });
    return { media, comments: result.data, source: 'instagram' };
  }
  if (view !== 'youtube_comments') throw Error('Unknown provider operation.');
  const youtube = (path: string, query: Record<string, string>) => {
    const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
    url.search = new URLSearchParams(query).toString();
    return request('youtube', url);
  };
  const owner = await youtube('channels', { part: 'id', mine: 'true', fields: 'items(id)', maxResults: '1' });
  const channel = owner.items?.[0]?.id;
  if (!channel || !/^UC[A-Za-z0-9_-]{22}$/.test(channel))
    throw Error('The connected Google identity has no YouTube channel.');
  const result = await youtube('commentThreads', {
    part: 'snippet',
    allThreadsRelatedToChannelId: channel,
    maxResults: size,
    order: 'time',
    textFormat: 'plainText',
    fields: 'items(id,snippet(channelId,videoId,topLevelComment(id,snippet(textDisplay,publishedAt))))',
  });
  return {
    channel,
    comments: (result.items || [])
      .filter((row: Json) => row.snippet?.channelId === channel)
      .map((row: Json) => ({
        id: row.snippet.topLevelComment.id,
        video: row.snippet.videoId,
        text: row.snippet.topLevelComment.snippet.textDisplay,
        published: row.snippet.topLevelComment.snippet.publishedAt,
      })),
  };
}

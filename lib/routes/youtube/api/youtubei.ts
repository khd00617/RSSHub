import { Innertube } from 'youtubei.js';

import type { Data, DataItem } from '@/types';
import cache from '@/utils/cache';
import { parseRelativeDate } from '@/utils/parse-date';

import utils, { getVideoUrl } from '../utils';
import { getSrtAttachmentBatch } from './subtitles';

let innertubePromise: Promise<Innertube> | undefined;

const getInnertube = () => {
    if (!innertubePromise) {
        // Lazy init to avoid network calls during import time (e.g. when building)
        innertubePromise = Innertube.create({
            // Japanese locale so titles and dates match the ja-JP page scraping source.
            lang: 'ja',
            location: 'JP',
            fetch: (input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

                return fetch(url, {
                    method: input?.method,
                    ...init,
                });
            },
        });
    }
    return innertubePromise;
};

// Japanese relative dates such as "1 か月前" need unit normalization, live streams
// use the "7 時間前 に配信済み" form (note the space), and unparseable texts must
// yield undefined instead of an Invalid Date.
const parseRelativeDateOrUndefined = (text?: string) => {
    if (!text) {
        return;
    }
    const normalized = text
        .replaceAll(/前\s*に配信済み/g, '前')
        .replaceAll(/配信済み[:：]\s*/g, '')
        .replaceAll(/か月|ヶ月/g, '月');
    const date = parseRelativeDate(normalized);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

export const getChannelIdByUsername = (username: string) =>
    cache.tryGet(`youtube:getChannelIdByUsername:${username}`, async () => {
        const innertube = await getInnertube();
        const navigationEndpoint = await innertube.resolveURL(`https://www.youtube.com/${username}`);
        return navigationEndpoint.payload.browseId;
    });

export const getDataByUsername = async ({ username, embed, filterShorts, isJsonFeed }: { username: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const channelId = (await getChannelIdByUsername(username)) as string;
    return getDataByChannelId({ channelId, embed, filterShorts, isJsonFeed });
};

export const getRecentDataByChannelId = async ({ channelId, query }: { channelId: string; query: string }): Promise<DataItem[]> => {
    const innertube = await getInnertube();
    const search = await innertube.search(query, { type: 'video', upload_date: 'month' });
    const videos = search.videos as Array<{
        video_id: string;
        title: { text: string };
        description_snippet?: { text: string };
        author?: { id?: string; name?: string };
        published?: { text?: string };
    }>;

    return videos
        .filter((video) => video.author?.id === channelId && video.published?.text)
        .map((video) => ({
            title: video.title.text,
            description: video.description_snippet?.text,
            link: `https://www.youtube.com/watch?v=${video.video_id}`,
            guid: video.video_id,
            pubDate: parseRelativeDateOrUndefined(video.published?.text),
            author: video.author?.name,
        }));
};

export const getDataByChannelId = async ({ channelId, embed, isJsonFeed, includeLive = false }: { channelId: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean; includeLive?: boolean }): Promise<Data> => {
    const innertube = await getInnertube();
    const channel = await innertube.getChannel(channelId);
    const videos = await channel.getVideos();
    // Live streams and premieres do not always appear on the videos tab; merge the
    // live tab so the newest content is not missed. Channels without a live tab throw.
    let liveVideos: typeof videos.videos = [];
    if (includeLive) {
        try {
            liveVideos = (await channel.getLiveStreams()).videos;
        } catch {
            // No live tab for this channel; keep the videos tab results only.
        }
    }
    const allVideos = [...videos.videos, ...liveVideos];
    const videoSubtitles = isJsonFeed
        ? await getSrtAttachmentBatch(allVideos.map((video) => ('video_id' in video ? video.video_id : 'content_id' in video ? video.content_id : undefined)).filter((videoId): videoId is string => Boolean(videoId)))
        : {};

    return {
        title: `${channel.metadata.title || channelId} - YouTube`,
        link: `https://www.youtube.com/channel/${channelId}`,
        image: channel.metadata.avatar?.[0].url,
        description: channel.metadata.description,

        item: await Promise.all(
            allVideos
                .filter((video) => 'video_id' in video || 'content_id' in video)
                .map((video) => {
                    if ('content_id' in video) {
                        // New lockup format used by the channel videos/live tabs. It carries no
                        // description snippet, so only the essentials are available.
                        const videoId = video.content_id;
                        const rows = video.metadata?.metadata?.metadata_rows ?? [];
                        const texts = rows.flatMap((row) => (row.metadata_parts ?? []).map((part) => part.text?.text));
                        const publishedText = texts.findLast((text) => text && /\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|時間|[秒分時日週月年]|か月|ヶ月)\s*(?:ago|に配信済み|[前後])?/i.test(text));
                        const img = video.content_image && 'image' in video.content_image ? video.content_image.image?.[0]?.url : undefined;

                        return {
                            title: video.metadata?.title.text || `YouTube Video ${videoId}`,
                            description: null,
                            link: `https://www.youtube.com/watch?v=${videoId}`,
                            author: channel.metadata.title || undefined,
                            image: img,
                            pubDate: parseRelativeDateOrUndefined(publishedText),
                            attachments: [
                                {
                                    url: getVideoUrl(videoId),
                                    mime_type: 'text/html',
                                },
                            ],
                        };
                    }
                    const srtAttachments = isJsonFeed ? videoSubtitles[video.video_id] || [] : [];
                    const img = 'best_thumbnail' in video ? video.best_thumbnail?.url : 'thumbnails' in video ? video.thumbnails?.[0]?.url : undefined;

                    return {
                        title: video.title.text || `YouTube Video ${video.video_id}`,
                        description: 'description_snippet' in video ? utils.renderDescription(embed, video.video_id, img, utils.formatDescription(video.description_snippet?.toHTML())) : null,
                        link: `https://www.youtube.com/watch?v=${video.video_id}`,
                        author: typeof video.author === 'string' ? video.author : video.author.name === 'N/A' ? undefined : video.author.name,
                        image: img,
                        pubDate: 'published' in video ? parseRelativeDateOrUndefined(video.published?.text) : undefined,
                        attachments: [
                            {
                                url: getVideoUrl(video.video_id),
                                mime_type: 'text/html',
                                duration_in_seconds: video.duration && 'seconds' in video.duration ? video.duration.seconds : undefined,
                            },
                            ...srtAttachments,
                        ],
                    };
                })
        ),
    };
};

export const getDataByPlaylistId = async ({ playlistId, embed }: { playlistId: string; embed: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const innertube = await getInnertube();
    const playlist = await innertube.getPlaylist(playlistId);
    const videos = await playlist.videos;

    return {
        title: `${playlist.info.title || playlistId} by ${playlist.info.author.name} - YouTube`,
        link: `https://www.youtube.com/playlist?list=${playlistId}`,
        image: playlist.info.thumbnails?.[0].url,
        description: playlist.info.description || `${playlist.info.title} by ${playlist.info.author.name}`,

        item: videos
            .filter((video) => 'id' in video)
            .map((video) => {
                const img = 'best_thumbnail' in video ? video.best_thumbnail?.url : video.thumbnails?.[0]?.url;

                return {
                    title: video.title.text || `YouTube Video ${video.id}`,
                    description: utils.renderDescription(embed, video.id, img, ''),
                    link: `https://www.youtube.com/watch?v=${video.id}`,
                    pubDate: 'published' in video ? parseRelativeDateOrUndefined(video.published?.text) : undefined,
                    author:
                        'author' in video
                            ? [
                                  {
                                      name: video.author.name,
                                      url: video.author.url,
                                      avatar: video.author.thumbnails?.[0]?.url,
                                  },
                              ]
                            : undefined,
                    image: img,
                    attachments: [
                        {
                            url: getVideoUrl(video.id),
                            mime_type: 'text/html',
                            duration_in_seconds: 'duration' in video && video.duration && 'seconds' in video.duration ? video.duration.seconds : undefined,
                        },
                    ],
                };
            }),
    };
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Data } from '@/types';

import { route } from './youtube-official/channel';

const mocks = vi.hoisted(() => ({
    cacheTryGet: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    cacheValues: new Map<string, string>(),
    getDataByChannelId: vi.fn(),
    getRecentDataByChannelId: vi.fn(),
    getSubtitlesByVideoId: vi.fn(),
    got: vi.fn(),
    parseString: vi.fn(),
}));

vi.mock('@/config', () => ({
    config: {
        commandcode: { apiKey: 'test-key', model: 'test-model' },
        opencode: {},
        trueUA: 'test-agent',
    },
}));

vi.mock('@/utils/cache', () => ({ default: { get: mocks.cacheGet, set: mocks.cacheSet, tryGet: mocks.cacheTryGet } }));
vi.mock('@/utils/got', () => ({ default: mocks.got }));
vi.mock('@/utils/logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/utils/wait', () => ({ default: vi.fn() }));
vi.mock('rss-parser', () => ({
    default: class {
        parseString(xml: string) {
            return mocks.parseString(xml);
        }
    },
}));
vi.mock('./youtube/api/subtitles', () => ({ getSubtitlesByVideoId: mocks.getSubtitlesByVideoId }));
vi.mock('./youtube/api/youtubei', () => ({
    getDataByChannelId: mocks.getDataByChannelId,
    getRecentDataByChannelId: mocks.getRecentDataByChannelId,
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheValues.clear();
    mocks.cacheGet.mockImplementation((key: string) => Promise.resolve(mocks.cacheValues.get(key) ?? null));
    mocks.cacheSet.mockImplementation((key: string, value: string | Record<string, unknown>) => {
        mocks.cacheValues.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        return Promise.resolve();
    });
    mocks.cacheTryGet.mockImplementation((_key: string, getValue: () => Promise<string>) => getValue());
    mocks.getSubtitlesByVideoId.mockResolvedValue('1\n00:00:00,000 --> 00:00:01,000\n字幕テキスト\n');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('youtube-official channel route', () => {
    it('uses the same GUID for official RSS and fallback items', async () => {
        const channelId = 'UC1234567890123456789012';
        const videoId = 'abc123def45';
        const link = `https://www.youtube.com/watch?v=${videoId}`;
        const context = { req: { param: () => channelId } };

        mocks.cacheTryGet.mockResolvedValue('Summary');
        mocks.got.mockResolvedValue({ body: '<feed />' });
        mocks.parseString.mockResolvedValue({
            title: 'Example channel',
            link: `https://www.youtube.com/channel/${channelId}`,
            items: [{ title: 'Example video', link, guid: link }],
        });

        const officialResult = (await route.handler(context as never)) as Data;

        mocks.got.mockImplementation(({ url }: { url: URL }) => {
            if (url.pathname === '/feeds/videos.xml') {
                throw new Error('RSS unavailable');
            }
            return { body: '' };
        });
        mocks.getDataByChannelId.mockResolvedValue({
            title: 'Example channel - YouTube',
            link: `https://www.youtube.com/channel/${channelId}`,
            item: [{ title: 'Example video', link, guid: videoId }],
        });
        mocks.getRecentDataByChannelId.mockResolvedValue([]);

        const fallbackResult = (await route.handler(context as never)) as Data;
        const expectedGuid = `https://www.youtube.com/watch?v=${videoId}`;

        expect(officialResult.item?.[0].guid).toBe(expectedGuid);
        expect(fallbackResult.item?.[0].guid).toBe(expectedGuid);
    });

    it('does not send quote-only cached subtitles to the LLM', async () => {
        const channelId = 'UC1234567890123456789012';
        const videoId = 'abc123def45';
        const link = `https://www.youtube.com/watch?v=${videoId}`;
        const context = { req: { param: () => channelId } };

        // Historical cache payload for a missing transcript: JSON '""'.
        mocks.getSubtitlesByVideoId.mockResolvedValue('""');
        mocks.got.mockResolvedValue({ body: '<feed />' });
        mocks.parseString.mockResolvedValue({
            title: 'Example channel',
            link: `https://www.youtube.com/channel/${channelId}`,
            items: [{ title: 'Example video', link, guid: link }],
        });
        // Pass through to the real summarize function so its guard runs.
        mocks.cacheTryGet.mockImplementation((_key: string, getValue: () => Promise<string>) => getValue());

        const result = (await route.handler(context as never)) as Data;

        expect(mocks.got).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'post' }));
        expect(result.item).toEqual([]);
    });

    it('omits a video until a retry after 24 hours successfully retrieves subtitles', async () => {
        vi.useFakeTimers();
        const discoveredAt = new Date('2026-09-28T00:00:00.000Z');
        vi.setSystemTime(discoveredAt);

        const channelId = 'UC1234567890123456789012';
        const videoId = 'abc123def45';
        const link = `https://www.youtube.com/watch?v=${videoId}`;
        const context = { req: { param: () => channelId } };
        mocks.getSubtitlesByVideoId.mockRejectedValueOnce(new Error('Caption fetch failed: 429'));
        mocks.got.mockResolvedValue({ body: '<feed />' });
        mocks.parseString.mockResolvedValue({
            title: 'Example channel',
            link: `https://www.youtube.com/channel/${channelId}`,
            items: [{ title: 'Example video', link, guid: link }],
        });

        const firstResult = (await route.handler(context as never)) as Data;
        const beforeRetryResult = (await route.handler(context as never)) as Data;

        expect(firstResult.item).toEqual([]);
        expect(beforeRetryResult.item).toEqual([]);
        expect(mocks.getSubtitlesByVideoId).toHaveBeenCalledTimes(1);

        vi.setSystemTime(discoveredAt.getTime() + 24 * 60 * 60 * 1000);
        mocks.cacheTryGet.mockResolvedValue('Summary');
        const recoveredResult = (await route.handler(context as never)) as Data;

        expect(mocks.getSubtitlesByVideoId).toHaveBeenCalledTimes(2);
        expect(recoveredResult.item).toHaveLength(1);
        expect(recoveredResult.item?.[0].description).toContain('Summary');
    });

    it('publishes a fixed subtitle-unavailable message after the final retry fails', async () => {
        vi.useFakeTimers();
        const discoveredAt = new Date('2026-09-28T00:00:00.000Z');
        vi.setSystemTime(discoveredAt);

        const channelId = 'UC1234567890123456789012';
        const videoId = 'abc123def45';
        const link = `https://www.youtube.com/watch?v=${videoId}`;
        const context = { req: { param: () => channelId } };
        mocks.getSubtitlesByVideoId.mockRejectedValue(new Error('Caption fetch failed: 429'));
        mocks.got.mockResolvedValue({ body: '<feed />' });
        mocks.parseString.mockResolvedValue({
            title: 'Example channel',
            link: `https://www.youtube.com/channel/${channelId}`,
            items: [{ title: 'Example video', link, guid: link }],
        });

        const firstResult = (await route.handler(context as never)) as Data;
        vi.setSystemTime(discoveredAt.getTime() + 24 * 60 * 60 * 1000 - 1);
        const beforeRetryResult = (await route.handler(context as never)) as Data;
        expect(firstResult.item).toEqual([]);
        expect(beforeRetryResult.item).toEqual([]);
        expect(mocks.getSubtitlesByVideoId).toHaveBeenCalledTimes(1);

        vi.setSystemTime(discoveredAt.getTime() + 24 * 60 * 60 * 1000);
        const finalResult = (await route.handler(context as never)) as Data;
        const laterResult = (await route.handler(context as never)) as Data;

        expect(finalResult.item).toHaveLength(1);
        expect(finalResult.item?.[0].description).toContain('字幕を取得できませんでした');
        expect(laterResult.item?.[0].description).toContain('字幕を取得できませんでした');
        expect(mocks.getSubtitlesByVideoId).toHaveBeenCalledTimes(2);
    });

    it('does not cache LLM empty-transcript refusals', async () => {
        const channelId = 'UC1234567890123456789012';
        const videoId = 'abc123def45';
        const link = `https://www.youtube.com/watch?v=${videoId}`;
        const context = { req: { param: () => channelId } };

        vi.mocked(mocks.getSubtitlesByVideoId).mockResolvedValue('1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n');
        mocks.got.mockResolvedValue({ body: '<feed />' });
        mocks.parseString.mockResolvedValue({
            title: 'Example channel',
            link: `https://www.youtube.com/channel/${channelId}`,
            items: [{ title: 'Example video', link, guid: link }],
        });
        mocks.cacheTryGet.mockImplementation((_key: string, getValue: () => Promise<string>) => getValue());
        mocks.got.mockImplementation((options: { method?: string }) => {
            if (options.method === 'post') {
                return { data: { choices: [{ message: { content: '入力された文字起こしが空のため、要約は作成できません。' } }] } };
            }
            return { body: '<feed />' };
        });

        const result = (await route.handler(context as never)) as Data;

        expect(result.item?.[0].description).toContain('要約を取得できませんでした');
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Data } from '@/types';
import { fetchFulltext } from '@/utils/fulltext';
import parser from '@/utils/rss-parser';

import { route } from './fulltext/index';

vi.mock('@/utils/rss-parser', () => ({
    default: {
        parseURL: vi.fn(),
    },
}));

vi.mock('@/utils/fulltext', () => ({
    fetchFulltext: vi.fn((item) => Promise.resolve({ ...item, description: `<p>Full text for ${item.title}</p>` })),
}));

const createContext = (feedPath: string, query: Record<string, string> = {}) => ({
    req: {
        url: `http://localhost/fulltext/${feedPath}${new URLSearchParams(query).toString() ? `?${new URLSearchParams(query)}` : ''}`,
        param: (name: string) => (name === 'feedPath' ? feedPath : undefined),
        query: (name: string) => query[name],
    },
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe('fulltext route', () => {
    it('parses a feed path and fetches fulltext without mode=fulltext', async () => {
        vi.mocked(parser.parseURL).mockResolvedValueOnce({
            title: 'Example feed',
            link: 'https://example.com',
            description: 'Example description',
            items: [
                {
                    title: 'Article',
                    link: 'https://example.com/article',
                    content: 'Summary',
                    pubDate: '2026-08-10T00:00:00.000Z',
                },
            ],
        } as any);

        const result = (await route.handler(createContext('example.com/feed.xml') as never)) as Data;

        expect(parser.parseURL).toHaveBeenCalledWith('https://example.com/feed.xml');
        expect(fetchFulltext).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Article',
                link: 'https://example.com/article',
                pubDate: '2026-08-10T00:00:00.000Z',
                description: 'Summary',
                category: undefined,
            })
        );
        expect(result.item?.[0].description).toBe('<p>Full text for Article</p>');
    });

    it('rejects localhost feed URLs', async () => {
        await expect(route.handler(createContext('localhost/feed.xml') as never)).rejects.toThrow('Only public HTTP(S) RSS feed URLs are supported');
        expect(parser.parseURL).not.toHaveBeenCalled();
    });
});

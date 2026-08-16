import { isIP } from 'node:net';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, DataItem, Route } from '@/types';
import { fetchFulltext } from '@/utils/fulltext';
import parser from '@/utils/rss-parser';

const isUnsafeHostname = (hostname: string) => {
    const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');

    return normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost') || normalizedHostname.endsWith('.local') || isIP(normalizedHostname) !== 0;
};

const getFeedUrl = (feedPath: string, requestParams: URLSearchParams) => {
    const feedUrl = /^https?:\/\//i.test(feedPath) ? feedPath : `https://${feedPath}`;
    let parsedUrl: URL;

    try {
        parsedUrl = new URL(feedUrl);
    } catch {
        throw new InvalidParameterError('Invalid RSS feed URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || isUnsafeHostname(parsedUrl.hostname)) {
        throw new InvalidParameterError('Only public HTTP(S) RSS feed URLs are supported');
    }

    for (const [key, value] of requestParams) {
        if (!['limit', 'mode'].includes(key)) {
            parsedUrl.searchParams.append(key, value);
        }
    }

    return parsedUrl.href;
};

export const route: Route = {
    path: '/:feedPath{.+}',
    categories: ['reading'],
    example: '/fulltext/pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf',
    parameters: { feedPath: 'RSS feed URL without the http:// or https:// prefix' },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'Fulltext RSS',
    maintainers: ['DIYgod'],
    handler,
    description: 'Fetch an arbitrary public RSS feed and replace item summaries with article fulltext.',
};

async function handler(ctx): Promise<Data> {
    const requestUrl = new URL(ctx.req.url);
    const feedUrl = getFeedUrl(ctx.req.param('feedPath'), requestUrl.searchParams);
    const requestedLimit = Math.trunc(Number(ctx.req.query('limit') ?? '20')) || 20;
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const feed = await parser.parseURL(feedUrl);
    const items: DataItem[] = feed.items.slice(0, limit).map((item) => ({
        title: item.title ?? '',
        link: item.link,
        pubDate: item.pubDate,
        description: item.content ?? (item as { description?: string }).description,
        category: item.categories,
    }));

    return {
        title: feed.title ?? feedUrl,
        link: feed.link ?? feedUrl,
        description: feed.description,
        item: await Promise.all(items.map((item) => fetchFulltext(item))),
    };
}

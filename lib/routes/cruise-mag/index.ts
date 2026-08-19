import { load } from 'cheerio';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import { parseDate } from '@/utils/parse-date';

const rootUrl = 'https://www.cruise-mag.com';
const newsUrl = `${rootUrl}/news/`;

export const route: Route = {
    path: '/news',
    categories: ['new-media'],
    example: '/cruise-mag/news',
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['www.cruise-mag.com/news/'],
        },
    ],
    name: 'ニュース',
    maintainers: ['khd00617'],
    handler: async (ctx) => {
        const response = await got(newsUrl);
        const $ = load(response.data);
        const limit = Math.trunc(Number(ctx.req.query('limit') ?? '20'));

        const links = $('.News_List > .News_Box > a')
            .slice(0, Number.isNaN(limit) ? 20 : limit)
            .toArray()
            .map((element) => {
                const item = $(element);
                const link = item.attr('href');

                if (!link) {
                    return null;
                }

                return {
                    title: item.find('.Title').text().trim(),
                    link,
                    category: [item.find('.Cat').text().trim()],
                    pubDate: parseDate(item.find('.Day').text().trim()),
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

        const items = await Promise.all(
            links.map((item) =>
                cache.tryGet(item.link, async () => {
                    const articleResponse = await got(item.link);
                    const article = load(articleResponse.data);
                    const content = article('.Contents_Text').html();

                    return {
                        ...item,
                        description: content || item.title,
                    };
                })
            )
        );

        return {
            title: 'クルーズマガジン ニュース',
            link: newsUrl,
            item: items,
        };
    },
    description: 'クルーズマガジンのニュース一覧を配信します。',
};

import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import * as entities from 'entities';

import type { DataItem } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';

const maxFulltextPages = 20;

type ParsedPage = {
    author?: string;
    content?: string;
    nextUrl?: string;
};

const getNextPageUrl = ($: CheerioAPI, pageUrl: string) => {
    const nextHref = $(
        'link[rel~="next"], a[rel~="next"], a.next, a.next-page, a.nextPage, a.pager-next, .article-pager a.next, .pagination a.next, .pagination a.next-page, .pager a.next, a[aria-label="次のページ"], a[aria-label="次ページ"], a:contains("次のページ"), a:contains("次ページ")'
    )
        .first()
        .attr('href');

    if (!nextHref) {
        return;
    }

    try {
        const nextUrl = new URL(nextHref, pageUrl);
        return nextUrl.protocol === 'http:' || nextUrl.protocol === 'https:' ? nextUrl.href : undefined;
    } catch {
        return;
    }
};

const fetchParsedPage = (pageUrl: string): Promise<ParsedPage> =>
    cache.tryGet(`mercury-cache-page-${pageUrl}`, async () => {
        try {
            const { default: Parser } = await import('@jocmp/mercury-parser');
            const response = await ofetch(pageUrl);
            const $ = load(response);
            const result = await Parser.parse(pageUrl, { html: $.html() });

            return {
                author: result.author,
                content: result.content,
                nextUrl: getNextPageUrl($, pageUrl),
            };
        } catch {
            return {};
        }
    });

const fetchPages = async (currentUrl: string | undefined, visitedUrls: Set<string>, contents: string[], firstPage: ParsedPage | undefined, pageIndex: number): Promise<ParsedPage | undefined> => {
    if (!currentUrl || pageIndex >= maxFulltextPages) {
        return firstPage;
    }

    let pageUrl: URL;
    try {
        pageUrl = new URL(currentUrl);
    } catch {
        return firstPage;
    }

    const normalizedUrl = pageUrl.href;
    if (visitedUrls.has(normalizedUrl)) {
        return firstPage;
    }
    visitedUrls.add(normalizedUrl);

    const parsedPage = await fetchParsedPage(normalizedUrl);
    const firstParsedPage = firstPage ?? parsedPage;

    if (parsedPage.content) {
        contents.push(parsedPage.content);
    }

    if (!parsedPage.nextUrl) {
        return firstParsedPage;
    }

    let nextUrl: URL;
    try {
        nextUrl = new URL(parsedPage.nextUrl, normalizedUrl);
    } catch {
        return firstParsedPage;
    }

    if (nextUrl.origin !== pageUrl.origin) {
        return firstParsedPage;
    }

    return fetchPages(nextUrl.href, visitedUrls, contents, firstParsedPage, pageIndex + 1);
};

const fetchAllPages = async (link: string) => {
    const contents: string[] = [];
    const firstPage = await fetchPages(link, new Set<string>(), contents, undefined, 0);

    return {
        author: firstPage?.author,
        content: contents.join('<hr>'),
    };
};

export async function fetchFulltext(item: DataItem): Promise<DataItem> {
    const { link, author, description } = item;
    const parsedResult = await cache.tryGet<ParsedPage>(`mercury-cache-fulltext-${link}`, () => {
        if (!link) {
            return Promise.resolve({});
        }

        return fetchAllPages(link);
    });

    return {
        ...item,
        author: author || parsedResult.author,
        description: parsedResult.content && parsedResult.content.length > 40 ? entities.decodeXML(parsedResult.content) : description,
    };
}

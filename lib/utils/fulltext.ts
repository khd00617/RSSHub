import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import * as entities from 'entities';
import iconv from 'iconv-lite';

import type { DataItem } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';

const maxFulltextPages = 20;

type ParsedPage = {
    author?: string;
    content?: string;
    nextUrl?: string;
};

const getCharset = (contentType: string, html: string) => {
    const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? html.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    return charset?.toLowerCase() ?? 'utf-8';
};

const fetchHtml = async (pageUrl: string) => {
    const response = await ofetch.raw(pageUrl, { responseType: 'arrayBuffer' });
    const data = response._data;
    const bytes = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer);
    const html = typeof bytes === 'string' ? bytes : iconv.decode(bytes, 'utf-8');
    const charset = getCharset(response.headers.get('content-type') ?? '', html);

    return charset === 'utf-8' ? html : iconv.decode(bytes, charset);
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

const getImpressWatchContent = ($: CheerioAPI, pageUrl: string) => {
    let hostname: string;
    try {
        hostname = new URL(pageUrl).hostname;
    } catch {
        return;
    }

    if (!hostname.endsWith('.watch.impress.co.jp') && hostname !== 'watch.impress.co.jp') {
        return;
    }

    const content = $('article[role="main"] .main-contents').first();
    if (!content.length) {
        return;
    }

    content.find('script, style, .affiliate_tag_multi, .article-pager, .pagination, .related, .recommend, .social-bookmark').remove();

    content.find('.image-wrap').each((_, element) => {
        const wrapper = $(element);
        const media = wrapper.find('img, iframe').first();
        if (!media.length) {
            return;
        }

        media.removeAttr('class id style width height');

        const mediaLink = media.closest('a').first();
        const mediaBlock = $('<div class="rsshub-fulltext-media"></div>');
        const mediaParagraph = $('<p></p>');
        mediaParagraph.append(mediaLink.length ? mediaLink.clone().empty().append(media.clone()) : media.clone());
        mediaBlock.append(mediaParagraph);

        const caption = wrapper.find('.caption').first();
        if (caption.length && caption.html()?.trim()) {
            mediaBlock.append($('<p></p>').html(caption.html()!));
        }

        wrapper.replaceWith(mediaBlock);
    });

    content.find('img, iframe').removeAttr('class id style width height');
    return content.html() ?? undefined;
};

const fetchParsedPage = (pageUrl: string): Promise<ParsedPage> =>
    cache.tryGet(`mercury-cache-page-v4-${pageUrl}`, async () => {
        try {
            const { default: Parser } = await import('@jocmp/mercury-parser');
            const html = await fetchHtml(pageUrl);
            const $ = load(html);
            const result = await Parser.parse(pageUrl, { html: $.html() });

            return {
                author: result.author,
                content: getImpressWatchContent($, pageUrl) ?? result.content,
                nextUrl: result.next_page_url ?? getNextPageUrl($, pageUrl),
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
    const parsedResult = await cache.tryGet<ParsedPage>(`mercury-cache-fulltext-v4-${link}`, () => {
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

import parser from '@jocmp/mercury-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ofetch from '@/utils/ofetch';

import { fetchFulltext } from './fulltext';

vi.mock('@jocmp/mercury-parser', () => ({
    default: {
        parse: vi.fn(),
    },
}));

vi.mock('@/utils/cache', () => ({
    default: {
        tryGet: vi.fn((_key: string, getValue: () => Promise<unknown>) => getValue()),
    },
}));

vi.mock('@/utils/ofetch', () => ({
    default: vi.fn(),
}));

const pageHtml = new Map<string, string>();

beforeEach(() => {
    vi.clearAllMocks();
    pageHtml.clear();
    vi.mocked(ofetch).mockImplementation((url) => Promise.resolve(pageHtml.get(String(url)) ?? '<html></html>'));
    vi.mocked(parser.parse).mockImplementation((url) =>
        Promise.resolve({
            author: 'Author',
            content: `Content from ${url} with enough text to be treated as extracted article content.`,
        } as any)
    );
});

describe('fetchFulltext', () => {
    it('uses the Impress Watch main content instead of a sidebar', async () => {
        const link = 'https://av.watch.impress.co.jp/docs/news/2132788.html';
        pageHtml.set(link, '<aside class="latest"><div class="body">Sidebar content</div></aside><article role="main"><div class="main-contents"><p>Actual article content from Impress Watch.</p></div></article>');

        const result = await fetchFulltext({ title: 'Article', link, description: 'Summary' });

        expect(result.description).toContain('Actual article content from Impress Watch.');
        expect(result.description).not.toContain('Sidebar content');
    });

    it('normalizes Impress Watch media blocks for RSS readers', async () => {
        const link = 'https://av.watch.impress.co.jp/docs/news/2132824.html';
        pageHtml.set(
            link,
            '<article role="main"><div class="main-contents"><div class="image-wrap"><div class="img-wrap-h" style="width:480px;height:271px"><div class="img-wrap-w"><a href="https://example.com/image.jpg"><img class="resource" style="width:480px;height:271px" width="480" height="271" src="https://example.com/image.jpg"></a></div></div><span class="caption">Image caption</span></div><p>Article text starts here.</p></div></article>'
        );

        const result = await fetchFulltext({ title: 'Article', link, description: 'Summary' });

        expect(result.description).toContain(
            '<div class="rsshub-fulltext-media"><p><a href="https://example.com/image.jpg"><img src="https://example.com/image.jpg"></a></p><p>Image caption</p></div><p>Article text starts here.</p>'
        );
        expect(result.description).not.toContain('img-wrap-h');
        expect(result.description).not.toContain('height="271"');
        expect(result.description).not.toContain('style="width:480px');
    });

    it('combines same-origin article pages', async () => {
        const firstPage = 'https://example.com/article/1';
        const secondPage = 'https://example.com/article/2';
        pageHtml.set(firstPage, `<a rel="next" href="${secondPage}">Next</a>`);
        pageHtml.set(secondPage, '<p>Second page</p>');

        const result = await fetchFulltext({ title: 'Article', link: firstPage, description: 'Summary' });

        expect(result.author).toBe('Author');
        expect(result.description).toBe(`Content from ${firstPage} with enough text to be treated as extracted article content.<hr>Content from ${secondPage} with enough text to be treated as extracted article content.`);
        expect(ofetch).toHaveBeenCalledTimes(2);
        expect(parser.parse).toHaveBeenCalledTimes(2);
    });

    it('stops when a next-page link leaves the article origin', async () => {
        const firstPage = 'https://example.com/article/1';
        pageHtml.set(firstPage, '<a class="next" href="https://other.example.com/article/2">Next</a>');

        await fetchFulltext({ title: 'Article', link: firstPage, description: 'Summary' });

        expect(ofetch).toHaveBeenCalledTimes(1);
        expect(parser.parse).toHaveBeenCalledTimes(1);
    });

    it('stops on a cyclic next-page link', async () => {
        const firstPage = 'https://example.com/article/1';
        const secondPage = 'https://example.com/article/2';
        pageHtml.set(firstPage, `<a aria-label="次のページ" href="${secondPage}">次のページ</a>`);
        pageHtml.set(secondPage, `<a rel="next" href="${firstPage}">Next</a>`);

        await fetchFulltext({ title: 'Article', link: firstPage, description: 'Summary' });

        expect(ofetch).toHaveBeenCalledTimes(2);
        expect(parser.parse).toHaveBeenCalledTimes(2);
    });
});

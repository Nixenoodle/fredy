/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config, createConfig } from '../../lib/provider/pararius.js';
import { parse } from '../../lib/services/extractor/parser/parser.js';
import puppeteerExtractor, { launchBrowser, closeBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';
import logger from '../../lib/services/logger.js';

vi.mock('../../lib/services/extractor/puppeteerExtractor.js', () => ({
  default: vi.fn(),
  launchBrowser: vi.fn(async () => ({})),
  closeBrowser: vi.fn(async () => {}),
}));
vi.mock('../../lib/utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn(async () => {}),
}));

const fixture = (name) => readFile(new URL(`../testFixtures/${name}.html`, import.meta.url), 'utf8');
const englishUrl = 'https://www.pararius.com/apartments/amsterdam';
const dutchUrl = 'https://www.pararius.nl/huurwoningen/amsterdam';

/** Read a recorded card through the same parser and normalization used in the pipeline. */
async function listingFrom(name, url) {
  const raw = parse(config.crawlContainer, config.crawlFields, await fixture(name), url);
  return createConfig({ url, enabled: true }).normalize(raw[0]);
}

describe('Pararius cards', () => {
  it('reads English euro prices without treating comma thousands as decimals', async () => {
    const listing = await listingFrom('pararius', englishUrl);
    expect(listing).toMatchObject({
      title: 'Flat Rijnstraat',
      price: 2495,
      size: 75,
      rooms: 3,
      address: 'Rijnstraat, 1079 HT Amsterdam (Rijnbuurt)',
      link: 'https://www.pararius.com/apartment-for-rent/amsterdam/64c44c78/rijnstraat',
      description: 'Upholstered',
    });
    expect(listing.image).toMatch(/^https:\/\//);
    expect(listing.id).toBeTypeOf('string');
    for (const field of config.requiredFieldNames) expect(listing).toHaveProperty(field);
  });

  it('reads Dutch prices and multiword streets, keeping links on the Dutch site', async () => {
    expect(await listingFrom('pararius_nl', dutchUrl)).toMatchObject({
      price: 2500,
      size: 49,
      rooms: 2,
      address: 'Simon Stevinstraat, 1097 CA Amsterdam (Frankendael)',
      link: 'https://www.pararius.nl/appartement-te-huur/amsterdam/6aba9140/simon-stevinstraat',
      image: null,
    });
  });

  it('does not invent prices, rooms or images when they are absent', () => {
    const listing = createConfig({ url: dutchUrl }).normalize({ title: 'Studio Teststraat' });
    expect(listing).toMatchObject({ price: null, size: null, rooms: null, image: null, link: null });
  });

  it.each([
    [englishUrl, '€1,250.50 pcm', 1250.5],
    [dutchUrl, '€ 1.250,50 per maand', 1250.5],
    [dutchUrl, 'Prijs op aanvraag', null],
  ])('normalizes %s price %s', (url, price, expected) => {
    expect(createConfig({ url }).normalize({ price }).price).toBe(expected);
  });

  it('keeps each job URL and blacklist independent, preserving path filters', () => {
    const url = `${dutchUrl}/1000-2000/2-slaapkamers`;
    const first = createConfig({ url, enabled: true }, ['Gemeubileerd']);
    const second = createConfig({ url: englishUrl }, []);
    const listing = { title: 'Appartement', description: 'Gemeubileerd' };
    expect(first.url).toBe(url);
    expect(first.filter(listing)).toBe(false);
    expect(second.filter(listing)).toBe(true);
    expect(config.url).toBeNull();
    expect(config.filter).toBeUndefined();
  });

  it.each(['https://pararius.nl.evil.test/huurwoningen/amsterdam', 'http://www.pararius.nl', 'https://example.com'])(
    'refuses non-Pararius search URLs: %s',
    (url) => expect(() => createConfig({ url })).toThrow('Pararius searches must use'),
  );
});

describe('Pararius detail enrichment', () => {
  beforeEach(() => {
    vi.mocked(puppeteerExtractor).mockReset();
  });

  it('reuses the browser and reads the description without the heading', async () => {
    const listing = await listingFrom('pararius', englishUrl);
    const browser = {};
    vi.mocked(puppeteerExtractor).mockResolvedValue(await fixture('pararius_detail'));
    const enriched = await config.fetchDetails(listing, browser);
    expect(puppeteerExtractor).toHaveBeenCalledWith(listing.link, null, { browser, name: 'pararius_details' });
    expect(enriched.description).toContain('we cannot accept a guarantor');
    expect(enriched.description).not.toContain('Description');
    expect(enriched.price).toBe(listing.price);
    expect(listing.description).toBe('Upholstered');
  });

  it.each([null, '<html>Just a moment...</html>', '<div></div>'])(
    'keeps the card on a missing detail page',
    async (html) => {
      const listing = await listingFrom('pararius', englishUrl);
      vi.mocked(puppeteerExtractor).mockResolvedValue(html);
      expect(await config.fetchDetails(listing)).toBe(listing);
    },
  );

  it('keeps the card on a failed navigation', async () => {
    const listing = await listingFrom('pararius', englishUrl);
    vi.mocked(puppeteerExtractor).mockRejectedValue(new Error('Timeout'));
    expect(await config.fetchDetails(listing)).toBe(listing);
  });
});

describe('Pararius browser search', () => {
  beforeEach(() => {
    vi.mocked(puppeteerExtractor).mockReset();
  });

  it('reads bare rent, not total rent, and the lazy photo rather than a placeholder or badge', async () => {
    vi.mocked(puppeteerExtractor).mockResolvedValue(`
      <section class="listing-search-item">
        <h3 class="listing-search-item__title"><a class="listing-search-item__link--title" href="/apartment-for-rent/amsterdam/8dd8fcd5/leeuwendalersweg">Flat Leeuwendalersweg</a></h3>
        <div class="listing-search-item__depiction"><wc-picture>
          <template><picture><img src="https://example.com/property.jpg"></picture></template>
          <img src="data:image/svg+xml;utf8,placeholder">
        </wc-picture></div>
        <div class="listing-search-item__price-bare"><span class="listing-search-item__price-value">€2,825 <span>pcm</span></span></div>
        <div class="price-transparency-badge__total-price-value">€2,850 per month</div>
        <img src="/badge.svg">
      </section>`);
    const browser = {};
    const run = createConfig({ url: englishUrl });
    const raw = await run.getListings(englishUrl, browser);
    expect(puppeteerExtractor).toHaveBeenCalledWith(
      englishUrl,
      null,
      expect.objectContaining({ browser, name: 'pararius' }),
    );
    expect(run.normalize(raw[0])).toMatchObject({ price: 2825, image: 'https://example.com/property.jpg' });
  });

  it('reports a blocked fetch rather than inventing an empty search', async () => {
    vi.mocked(puppeteerExtractor).mockResolvedValue(null);
    await expect(config.getListings(englishUrl)).rejects.toThrow('Pararius could not be loaded');
  });

  it('accepts a successfully loaded search with no cards', async () => {
    vi.mocked(puppeteerExtractor).mockResolvedValue('<html><body>No results</body></html>');
    expect(await config.getListings(englishUrl)).toEqual([]);
  });
});

/** A minimal result page with Pararius's real next-link markup and a card per advert id. */
function searchPage(ids, next) {
  return (
    ids
      .map(
        (id) =>
          `<section class="listing-search-item"><h3 class="listing-search-item__title"><a class="listing-search-item__link--title" href="/apartment-for-rent/amsterdam/${id}/street">Flat Street</a></h3></section>`,
      )
      .join('') + (next ? `<a class="pagination__link pagination__link--next" href="${next}">Next</a>` : '')
  );
}

describe('Pararius pagination', () => {
  beforeEach(() => {
    vi.mocked(puppeteerExtractor).mockReset();
    vi.mocked(launchBrowser).mockClear();
    vi.mocked(closeBrowser).mockClear();
  });

  it('walks all next links and deduplicates promoted adverts across pages', async () => {
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(searchPage(['promoted', 'one'], '/apartments/amsterdam/page-2'))
      .mockResolvedValueOnce(searchPage(['promoted', 'two'], '/apartments/amsterdam/page-3'))
      .mockResolvedValueOnce(searchPage(['three']));
    const browser = {};
    const cards = await config.getListings(englishUrl, browser);
    expect(cards.map((card) => card.id.split('/')[3])).toEqual(['promoted', 'one', 'two', 'three']);
    expect(puppeteerExtractor).toHaveBeenCalledTimes(3);
    for (const [, , options] of vi.mocked(puppeteerExtractor).mock.calls) expect(options.browser).toBe(browser);
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it('starts from page one, preserving path filters and repeated query parameters', async () => {
    const base = `${dutchUrl}/1000-2000`;
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(searchPage(['one'], '/huurwoningen/amsterdam/1000-2000/page-2'))
      .mockResolvedValueOnce(searchPage(['two']));
    await config.getListings(`${base}/page-4?type=a&type=b`, {});
    expect(vi.mocked(puppeteerExtractor).mock.calls.map(([url]) => url)).toEqual([
      `${base}?type=a&type=b`,
      `${base}/page-2?type=a&type=b`,
    ]);
  });

  it('handles a trailing slash and a head rel=next link', async () => {
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(`<link rel="next" href="${englishUrl}/page-2">${searchPage(['one'])}`)
      .mockResolvedValueOnce(searchPage(['two']));
    expect(await config.getListings(`${englishUrl}/`, {})).toHaveLength(2);
  });

  it.each(['https://example.com/apartments/amsterdam/page-2', '/apartments/rotterdam/page-2', '/apartments/amsterdam'])(
    'does not follow a different search or revisit a page: %s',
    async (next) => {
      vi.mocked(puppeteerExtractor).mockResolvedValue(searchPage(['one'], next));
      expect(await config.getListings(englishUrl, {})).toHaveLength(1);
      expect(puppeteerExtractor).toHaveBeenCalledOnce();
    },
  );

  it('stops when the portal repeats the previous cards under a new URL', async () => {
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(searchPage(['one'], '/apartments/amsterdam/page-2'))
      .mockResolvedValueOnce(searchPage(['one'], '/apartments/amsterdam/page-3'));
    expect(await config.getListings(englishUrl, {})).toHaveLength(1);
    expect(puppeteerExtractor).toHaveBeenCalledTimes(2);
  });

  it('stops on an empty page even if it has a next link', async () => {
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(searchPage(['one'], '/apartments/amsterdam/page-2'))
      .mockResolvedValueOnce(searchPage([], '/apartments/amsterdam/page-3'));
    expect(await config.getListings(englishUrl, {})).toHaveLength(1);
    expect(puppeteerExtractor).toHaveBeenCalledTimes(2);
  });

  it.each(['blocked', 'network failure'])('keeps collected cards and warns on a later %s', async (failure) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const fetch = vi
        .mocked(puppeteerExtractor)
        .mockResolvedValueOnce(searchPage(['one'], '/apartments/amsterdam/page-2'));
      if (failure === 'blocked') fetch.mockResolvedValueOnce(null);
      else fetch.mockRejectedValueOnce(new Error('Network failure'));
      expect(await config.getListings(englishUrl, {})).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete search'));
    } finally {
      warn.mockRestore();
    }
  });

  it('caps a search at 100 pages and warns that it is incomplete', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      let page = 0;
      vi.mocked(puppeteerExtractor).mockImplementation(async () => {
        page++;
        return searchPage([String(page)], `/apartments/amsterdam/page-${page + 1}`);
      });
      expect(await config.getListings(englishUrl, {})).toHaveLength(100);
      expect(puppeteerExtractor).toHaveBeenCalledTimes(100);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('100-page safety limit'));
    } finally {
      warn.mockRestore();
    }
  });

  it('launches and closes a single browser when none was supplied', async () => {
    vi.mocked(puppeteerExtractor)
      .mockResolvedValueOnce(searchPage(['one'], '/apartments/amsterdam/page-2'))
      .mockResolvedValueOnce(searchPage(['two']));
    await config.getListings(englishUrl);
    expect(launchBrowser).toHaveBeenCalledOnce();
    const browser = await vi.mocked(launchBrowser).mock.results[0].value;
    expect(closeBrowser).toHaveBeenCalledExactlyOnceWith(browser);
    for (const [, , options] of vi.mocked(puppeteerExtractor).mock.calls) expect(options.browser).toBe(browser);
  });

  it('closes its own browser when the first page fails', async () => {
    vi.mocked(puppeteerExtractor).mockResolvedValue(null);
    await expect(config.getListings(englishUrl)).rejects.toThrow('Pararius could not be loaded');
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});

describe('Pararius browser activity check', () => {
  it.each([
    [200, '<div class="listing-detail-summary">Flat Rijnstraat</div>', 1],
    [404, 'Not found', 0],
    [410, 'Gone', 0],
    [403, 'Just a moment...', -1],
    [429, 'Rate limited', -1],
    [200, '<html>Unknown page</html>', -1],
  ])('handles status %s without confusing a refusal with a removed listing', async (status, html, expected) => {
    const page = {
      goto: vi.fn().mockResolvedValue({ status: () => status }),
      content: vi.fn().mockResolvedValue(html),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page) };
    expect(await config.browserActivityProbe(englishUrl, browser)).toBe(expected);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('closes the page after a timeout and returns unknown', async () => {
    const page = {
      goto: vi.fn().mockRejectedValue(new Error('Timeout')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    expect(await config.browserActivityProbe(englishUrl, { newPage: async () => page })).toBe(-1);
    expect(page.close).toHaveBeenCalledOnce();
  });
});

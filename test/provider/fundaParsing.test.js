/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, createConfig } from '../../lib/provider/funda.js';
import { readPageState, readSearchPage, readDetailPage } from '../../lib/services/funda/pageState.js';
import extractor, { launchBrowser, closeBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';
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

const searchUrl = 'https://www.funda.nl/zoeken/huur?selected_area=rotterdam';
const detailUrl = 'https://www.funda.nl/detail/huur/rotterdam/appartement-mijnsherenlaan-134-d/80904808/';
const fixture = (name) => readFile(new URL(`../testFixtures/${name}.html`, import.meta.url), 'utf8');
const searchHtml = await fixture('funda');
const detailHtml = await fixture('funda_detail');
const cards = readSearchPage(searchHtml).listings;

/** Render a minimal flattened Nuxt table for pagination/failure variations. Never executes scripts. */
function render(value) {
  const table = [null];
  const encode = (value) => {
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value)
      ? value.map(encode)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, encode(value)]))
        : value;
    return index;
  };
  table[0] = ['ShallowReactive', encode(value)];
  return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(table)}</script>`;
}

/** A synthetic search around actual sanitized card data. */
const pageHtml = (page, listings, total) =>
  render({ pinia: { search: { criteria: { page }, listings, totalListingsCount: total } } });

beforeEach(() => {
  vi.mocked(extractor).mockReset();
  vi.mocked(launchBrowser).mockClear();
  vi.mocked(closeBrowser).mockClear();
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Funda public page decoding', () => {
  it('reads numeric values and distinguishes total rooms from bedrooms', () => {
    const result = readSearchPage(searchHtml);
    expect(result).toMatchObject({ total: 2, page: 1 });
    const listing = config.normalize(result.listings[0]);
    expect(listing).toMatchObject({
      price: 1922,
      size: 92,
      rooms: 4,
      address: 'Mijnsherenlaan 134 D, 3081CK, Rotterdam',
      energyClass: 'D',
    });
    expect(listing.id).toMatch(/^[a-f0-9]{64}$/);
    expect(listing.publishedAt).toBe(Date.parse('2026-10-19T11:38:11.3514976+02:00'));
    expect(listing.image).toMatch(/^https:\/\/cloud\.funda\.nl\//);
    expect(listing.images).toHaveLength(1);
    for (const key of config.requiredFieldNames) expect(listing).toHaveProperty(key);
  });

  it('reads purchase prices and does not guess values from ranges or bedrooms', () => {
    expect(
      config.normalize({ id: 123, price: { selling_price: [350000] }, floor_area: [80], number_of_bedrooms: 2 }),
    ).toMatchObject({ price: 350000, size: 80, rooms: null });
    expect(config.normalize({ id: 124, price: { rent_price: [1000, 2000] }, floor_area: [40, 80] })).toMatchObject({
      price: null,
      size: null,
      rooms: null,
      image: null,
    });
  });

  it('includes the quoted price in listing identity', () => {
    expect(config.normalize({ ...cards[0], price: { rent_price: [2000] } }).id).not.toBe(config.normalize(cards[0]).id);
  });

  it('matches the search id cache key even when the canonical URL has a different id', () => {
    const detail = readDetailPage(detailHtml, detailUrl);
    expect(detail.globalId).toBe(8195809);
    expect(detail.canonicalUrl).toContain('/17277535/');
    expect(readDetailPage(detailHtml, detailUrl.replace('80904808', '12345'))).toBeNull();
  });

  it('supports shared references, reactive wrappers, undefined and cycles without eval', () => {
    const html = '<script id="__NUXT_DATA__">[{"self":0,"shared":1,"again":1,"missing":-1},["Ref",2],42]</script>';
    const state = readPageState(html);
    expect(state.self).toBe(state);
    expect(state.shared).toBe(42);
    expect(state.again).toBe(42);
    expect(state.missing).toBeUndefined();
  });

  it('does not allow prototype pollution and ignores unsupported tagged values', () => {
    const state = readPageState(
      '<script id="__NUXT_DATA__">[{"__proto__":1,"unknown":3},{"polluted":2},true,["UnknownTag",2]]</script>',
    );
    expect(Object.getPrototypeOf(state)).toBeNull();
    expect({}.polluted).toBeUndefined();
    expect(state.unknown).toBeNull();
  });

  it.each([
    '<html>Access Denied</html>',
    '<script id="__NUXT_DATA__">bad</script>',
    '<script id="__NUXT_DATA__">{}</script>',
  ])('rejects challenges and invalid payloads', (html) => {
    expect(() => readSearchPage(html)).toThrow();
  });
});

describe('Funda pagination and access failures', () => {
  it('walks every page, deduplicates overlaps and retains filters while resetting page/sort', async () => {
    vi.mocked(extractor)
      .mockResolvedValueOnce(pageHtml(1, cards, 16))
      .mockResolvedValueOnce(pageHtml(2, [cards[0], { ...cards[1], id: 999 }], 16));
    const browser = {};
    const result = await config.getListings(`${searchUrl}&page=8&price=1000-2000&sort=price_up`, browser);
    expect(result).toHaveLength(3);
    expect(result[0].link).toBe(detailUrl);
    const urls = vi.mocked(extractor).mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
    for (const url of urls) {
      expect(url.searchParams.get('price')).toBe('1000-2000');
      expect(url.searchParams.get('selected_area')).toBe('rotterdam');
      expect(url.searchParams.get('sort')).toBe('publish_date_sort_order_desc');
    }
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('page 2/2'));
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it('fails explicitly when the browser is refused, rather than returning no matches', async () => {
    vi.mocked(extractor).mockResolvedValue(null);
    await expect(config.getListings(searchUrl, {})).rejects.toThrow('Funda blocked or failed');
  });

  it('also refuses a 200 challenge page that the common bot detector did not recognise', async () => {
    vi.mocked(extractor).mockResolvedValue('<html><h1>Je bent bijna op de pagina die je zoekt</h1></html>');
    await expect(config.getListings(searchUrl, {})).rejects.toThrow('may be blocked');
  });

  it('keeps collected listings with a warning on a later block', async () => {
    vi.mocked(extractor)
      .mockResolvedValueOnce(pageHtml(1, cards, 16))
      .mockResolvedValueOnce(null);
    expect(await config.getListings(searchUrl, {})).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete search on page 2'));
  });

  it('detects ignored pagination', async () => {
    vi.mocked(extractor).mockResolvedValue(pageHtml(1, cards, 16));
    expect(await config.getListings(searchUrl, {})).toHaveLength(2);
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not return requested page 2'));
  });

  it('stops repeated cards even if the server increments the page number', async () => {
    vi.mocked(extractor)
      .mockResolvedValueOnce(pageHtml(1, cards, 100))
      .mockResolvedValueOnce(pageHtml(2, cards, 100));
    expect(await config.getListings(searchUrl, {})).toHaveLength(2);
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('repeated or invalid page'));
  });

  it('accepts a genuine empty search', async () => {
    vi.mocked(extractor).mockResolvedValue(pageHtml(1, [], 0));
    expect(await config.getListings(searchUrl, {})).toEqual([]);
  });

  it('bounds runaway pagination and warns', async () => {
    vi.mocked(extractor).mockImplementation(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return pageHtml(page, [{ ...cards[0], id: page }], 9999);
    });
    expect(await config.getListings(searchUrl, {})).toHaveLength(100);
    expect(extractor).toHaveBeenCalledTimes(100);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('100-page safety limit'));
  });

  it('closes a browser it owns, including on access failure', async () => {
    vi.mocked(extractor).mockResolvedValue(null);
    await expect(config.getListings(searchUrl)).rejects.toThrow();
    expect(launchBrowser).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});

describe('Funda details and probes', () => {
  const listing = config.normalize(cards[0]);
  it('enriches the original card without replacing its price or link with canonical data', async () => {
    vi.mocked(extractor).mockResolvedValue(detailHtml);
    const enriched = await config.fetchDetails(listing, {});
    expect(enriched).toMatchObject({
      link: detailUrl,
      price: 1922,
      rooms: 4,
      buildYear: 1938,
      latitude: 51.89206,
      longitude: 4.4902883,
    });
    expect(enriched.description).toContain('drie slaapkamers');
    expect(enriched.images).toHaveLength(2);
    expect(listing.description).toBe('');
    expect(await config.priceTracking.browserProbe(listing, {})).toBe(1922);
  });

  it('keeps the search card and reports unknown price if details are blocked', async () => {
    vi.mocked(extractor).mockResolvedValue(null);
    expect(await config.fetchDetails(listing, {})).toBe(listing);
    expect(await config.priceTracking.browserProbe(listing, {})).toBeNull();
  });

  it('does not use a different advert returned by the detail page', async () => {
    vi.mocked(extractor).mockResolvedValue(detailHtml);
    const other = { ...listing, link: detailUrl.replace('80904808', '999') };
    expect(await config.fetchDetails(other, {})).toBe(other);
    expect(await config.priceTracking.browserProbe(other, {})).toBeNull();
  });

  it.each([
    [200, detailHtml, 1],
    [200, '<h1>Access denied</h1>', -1],
    [403, '', -1],
    [429, '', -1],
    [404, '', 0],
    [410, '', 0],
  ])('handles HTTP %s without treating a challenge as removed', async (status, html, expected) => {
    const page = {
      goto: vi.fn(async () => ({ status: () => status })),
      content: vi.fn(async () => html),
      close: vi.fn(async () => {}),
    };
    expect(await config.browserActivityProbe(detailUrl, { newPage: async () => page })).toBe(expected);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it('recognizes an explicit sold/rented advert', async () => {
    const detail = readDetailPage(detailHtml, detailUrl);
    const html = render({ data: { cachedListingData_nl_80904808: { ...detail, isSoldOrRented: true } } });
    const page = { goto: async () => ({ status: () => 200 }), content: async () => html, close: async () => {} };
    expect(await config.browserActivityProbe(detailUrl, { newPage: async () => page })).toBe(0);
  });
});

describe('Funda run-scoped settings', () => {
  it('does not share blacklists or mutate the template', () => {
    expect(config.browserEngine).toBe('firefox');
    const first = createConfig({ url: searchUrl }, ['no pets']);
    const second = createConfig({ url: searchUrl }, []);
    expect(first.filter({ title: 'Flat', description: 'no pets' })).toBe(false);
    expect(second.filter({ title: 'Flat', description: 'no pets' })).toBe(true);
    expect(config.url).toBeNull();
    expect(config.filter).toBeUndefined();
  });

  it.each([
    'http://www.funda.nl/zoeken/huur',
    'https://www.funda.nl.evil.test/zoeken/huur',
    'https://www.funda.nl:444/zoeken/huur',
    detailUrl,
    'https://www.funda.nl/huur/rotterdam/',
    'https://www.funda.nl/zoeken/kaart/huur',
  ])('rejects non-search or foreign URLs: %s', (url) => {
    expect(() => createConfig({ url })).toThrow('list-view search');
  });

  it.each([`${searchUrl}&type=group`, `${searchUrl}&collapse_projects=true`])(
    'refuses grouped-project searches instead of misreading ranges',
    (url) => {
      expect(() => createConfig({ url })).toThrow('individual adverts');
    },
  );
});

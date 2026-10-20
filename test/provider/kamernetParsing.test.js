/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, createConfig, metaInformation } from '../../lib/provider/kamernet.js';
import logger from '../../lib/services/logger.js';

vi.mock('../../lib/utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn(async () => {}),
}));

const searchUrl = 'https://kamernet.nl/en/for-rent/properties-rotterdam?radius=1';
const detailUrl = 'https://kamernet.nl/en/for-rent/room-rotterdam/oostzeedijk/room-2412792';
const fixture = (name) => readFile(new URL(`../testFixtures/${name}.html`, import.meta.url), 'utf8');
const firstHtml = await fixture('kamernet');
const secondHtml = await fixture('kamernet_page2');
const detailHtml = await fixture('kamernet_detail');

/** The Next.js page state, for controlled variations over the recorded public responses. */
function propsOf(html) {
  return JSON.parse(cheerio.load(html)('#__NEXT_DATA__').text()).props.pageProps;
}

/** A minimal HTTP response, including headers for guarded redirects. */
function response(html, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => html, headers: new Headers(headers) };
}

/** Render a variation without copying any real account/landlord profile into a fixture. */
function render(props, links = '') {
  return `${links}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: props } })}</script>`;
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Kamernet search', () => {
  it('reads all pages, deduplicating promoted cards and excluding nearby recommendations', async () => {
    fetchMock.mockResolvedValueOnce(response(firstHtml)).mockResolvedValueOnce(response(secondHtml));
    const cards = await config.getListings(searchUrl);
    expect(cards.map((card) => card.listingId)).toEqual([2412792, 2412752, 2412289]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('page 2/2, 3 unique listings'));
    expect(cards[0].link).toBe(detailUrl);
    expect(cards[1].link).toContain('/apartment-delft/');
  });

  it('resets pagination and sorting without dropping any other search filters', async () => {
    fetchMock.mockResolvedValueOnce(response(firstHtml)).mockResolvedValueOnce(response(secondHtml));
    await config.getListings(`${searchUrl}&pageNo=8&sort=2&maxRent=10&furnishings=1,2&flag=a&flag=b`);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get('pageNo'))).toEqual(['1', '2']);
    for (const url of urls) {
      expect(url.searchParams.get('sort')).toBe('1');
      expect(url.searchParams.get('radius')).toBe('1');
      expect(url.searchParams.get('maxRent')).toBe('10');
      expect(url.searchParams.get('furnishings')).toBe('1,2');
      expect(url.searchParams.getAll('flag')).toEqual(['a', 'b']);
    }
  });

  it('keeps Dutch listing URLs rather than synthesizing English paths', async () => {
    fetchMock
      .mockResolvedValueOnce(response(firstHtml.replaceAll('/en/for-rent/', '/huren/').replaceAll('/room-', '/kamer-')))
      .mockResolvedValueOnce(response(secondHtml));
    const cards = await config.getListings('https://kamernet.nl/huren/woningen-rotterdam');
    expect(cards[0].link).toBe('https://kamernet.nl/huren/kamer-rotterdam/oostzeedijk/kamer-2412792');
  });

  it.each([403, 429, 503])('does not treat HTTP %s as an empty first page', async (status) => {
    fetchMock.mockResolvedValue(response('Unavailable', status));
    await expect(config.getListings(searchUrl)).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([
    '<html>Just a moment...</html>',
    '<script id="__NEXT_DATA__">broken</script>',
    render({ hasError500: true }),
  ])('refuses an unavailable or malformed first page', async (html) => {
    fetchMock.mockResolvedValue(response(html));
    await expect(config.getListings(searchUrl)).rejects.toThrow();
  });

  it('retains collected cards and warns when a later request fails', async () => {
    fetchMock.mockResolvedValueOnce(response(firstHtml)).mockRejectedValueOnce(new Error('Network failure'));
    expect(await config.getListings(searchUrl)).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete search on page 2'));
  });

  it('detects a server ignoring pageNo instead of walking the same page forever', async () => {
    fetchMock.mockResolvedValue(response(firstHtml));
    expect(await config.getListings(searchUrl)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not return requested page 2'));
  });

  it('accepts a genuine empty search', async () => {
    const props = propsOf(firstHtml);
    props.targetPageProps.findListingsResponse = {
      listings: [],
      topAdListings: [],
      total: 0,
      OpResponse: { Code: 1000 },
    };
    fetchMock.mockResolvedValue(response(render(props)));
    expect(await config.getListings(searchUrl)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not collect a nearby recommendation even if it has a rendered detail link', async () => {
    const html = firstHtml + '<a href="/en/for-rent/room-delft/street/room-9999999">Nearby</a>';
    fetchMock.mockResolvedValueOnce(response(html)).mockResolvedValueOnce(response(secondHtml));
    expect((await config.getListings(searchUrl)).map((card) => card.listingId)).not.toContain(9999999);
  });

  it('stops repeated cards even when the server increments the page metadata', async () => {
    const props = propsOf(firstHtml);
    props.targetPageProps.allFilters.pageNo = 2;
    props.targetPageProps.findListingsResponse.total = 100;
    fetchMock
      .mockResolvedValueOnce(response(firstHtml))
      .mockResolvedValueOnce(response(render(props, firstHtml.split('<script')[0])));
    expect(await config.getListings(searchUrl)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('repeated/invalid page'));
  });

  it('warns if the portal stops returning cards before its reported total', async () => {
    const props = propsOf(secondHtml);
    props.targetPageProps.findListingsResponse.listings = [];
    props.targetPageProps.findListingsResponse.topAdListings = [];
    fetchMock.mockResolvedValueOnce(response(firstHtml)).mockResolvedValueOnce(response(render(props)));
    expect(await config.getListings(searchUrl)).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('empty page before the reported total'));
  });

  it('caps a runaway search at 100 pages with an explicit warning', async () => {
    fetchMock.mockImplementation(async (url) => {
      const page = Number(new URL(url).searchParams.get('pageNo'));
      const props = propsOf(firstHtml);
      props.targetPageProps.allFilters = { pageNo: page, listingsPerPage: 1 };
      props.targetPageProps.findListingsResponse.total = 1000;
      props.targetPageProps.findListingsResponse.listings = [{ listingId: page }];
      return response(render(props, `<a href="/en/for-rent/room-rotterdam/street/room-${page}">Room</a>`));
    });
    expect(await config.getListings(searchUrl)).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('100-page safety limit'));
  });

  it('fails loudly if a changed page no longer contains usable detail links', async () => {
    fetchMock.mockResolvedValue(response(render(propsOf(firstHtml))));
    await expect(config.getListings(searchUrl)).rejects.toThrow('without usable listing links');
  });

  it('refuses malformed page metadata before collecting cards', async () => {
    const props = propsOf(firstHtml);
    props.targetPageProps.allFilters.listingsPerPage = 0;
    fetchMock.mockResolvedValue(response(render(props, firstHtml.split('<script')[0])));
    await expect(config.getListings(searchUrl)).rejects.toThrow('invalid pagination metadata');
  });

  it('follows a same-portal canonical redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(response('', 308, { location: `${searchUrl}&pageNo=1&sort=1` }))
      .mockResolvedValueOnce(response(firstHtml))
      .mockResolvedValueOnce(response(secondHtml));
    expect(await config.getListings(searchUrl)).toHaveLength(3);
  });

  it('refuses an off-site redirect before making a request to it', async () => {
    fetchMock.mockResolvedValue(response('', 302, { location: 'http://127.0.0.1/private' }));
    await expect(config.getListings(searchUrl)).rejects.toThrow('Kamernet URLs must use');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds redirect loops', async () => {
    fetchMock.mockResolvedValue(response('', 302, { location: searchUrl }));
    await expect(config.getListings(searchUrl)).rejects.toThrow('too many redirects');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('Kamernet normalization and run-scoped configuration', () => {
  const card = propsOf(firstHtml).targetPageProps.findListingsResponse.listings[0];

  it('normalizes the price and utilities flag and produces a nonempty stable id', () => {
    const listing = config.normalize({ ...card, link: detailUrl });
    expect(listing).toMatchObject({
      price: 600,
      size: 18,
      rooms: 1,
      chargesIncluded: true,
      address: 'Oostzeedijk, Rotterdam',
    });
    expect(listing.id).toMatch(/^[a-f0-9]{64}$/);
    expect(config.normalize({ ...card, totalRentalPrice: 650 }).id).not.toBe(listing.id);
    for (const key of config.requiredFieldNames) expect(listing).toHaveProperty(key);
  });

  it('does not invent a room count for apartments or a price when missing', () => {
    expect(config.normalize({ listingId: 1, listingType: 2 })).toMatchObject({
      price: null,
      size: null,
      rooms: null,
      image: null,
    });
  });

  it('binds each blacklist and preserves the static template', () => {
    const first = createConfig({ url: searchUrl }, ['no pets']);
    const second = createConfig({ url: 'https://kamernet.nl/huren/kamer-rotterdam' }, []);
    expect(first.filter({ title: 'Room', description: 'no pets' })).toBe(false);
    expect(second.filter({ title: 'Room', description: 'no pets' })).toBe(true);
    expect(first.url).toBe(searchUrl);
    expect(config.url).toBeNull();
    expect(config.filter).toBeUndefined();
    expect(metaInformation.countries).toEqual(['nl']);
  });

  it.each([
    'https://kamernet.nl.evil.test/huren/kamer-rotterdam',
    'http://kamernet.nl/huren/kamer-rotterdam',
    'https://kamernet.nl:444/huren/kamer-rotterdam',
  ])('rejects non-portal URLs: %s', (url) => {
    expect(() => createConfig({ url })).toThrow('Kamernet URLs must use');
  });

  it.each([detailUrl, 'https://kamernet.nl/my-account', `${searchUrl}&searchView=3`])(
    'rejects non-list searches: %s',
    (url) => {
      expect(() => createConfig({ url })).toThrow('list-view search');
    },
  );

  it.each([
    [0, null],
    [10, 1000],
    [15, 1500],
    [16, 1750],
    [17, 2000],
    [33, 6000],
    [34, 20000],
    [1000, null],
  ])('decodes maxRent dropdown %s as %s euros', (code, max) => {
    expect(config.priceRangeParams.parse(`${searchUrl}&maxRent=${code}`)).toEqual({ min: null, max });
  });
});

describe('Kamernet public details, availability and price tracking', () => {
  const listing = config.normalize({
    ...propsOf(firstHtml).targetPageProps.findListingsResponse.listings[0],
    link: detailUrl,
  });

  it('enriches with the public description, address, coordinates and gallery only', async () => {
    fetchMock.mockResolvedValue(response(detailHtml));
    const enriched = await config.fetchDetails(listing);
    expect(enriched).toMatchObject({
      price: 600,
      rooms: 1,
      address: 'Oostzeedijk 122, 3063BH, Rotterdam',
      latitude: 51.920843,
      longitude: 4.508585,
    });
    expect(enriched.description).toContain('inschrijven mag');
    expect(enriched.images).toHaveLength(3);
    expect(enriched).not.toHaveProperty('landlordUserId');
    expect(listing.description).toBe('');
  });

  it('chooses Dutch description for a Dutch page and reads stated total rooms, not bedrooms', async () => {
    const props = propsOf(detailHtml);
    props.locale = 'nl';
    props.targetPageProps.listingDetails.dutchDescription = 'Nederlandse beschrijving';
    props.targetPageProps.listingDetails.numOfRooms = 3;
    props.targetPageProps.listingDetails.numOfBedrooms = 2;
    fetchMock.mockResolvedValue(response(render(props)));
    expect(await config.fetchDetails(listing)).toMatchObject({ description: 'Nederlandse beschrijving', rooms: 3 });
  });

  it('does not use the coordinates when only half a position is available', async () => {
    const props = propsOf(detailHtml);
    props.targetPageProps.listingDetails.postalCodeLat = null;
    fetchMock.mockResolvedValue(response(render(props)));
    expect(await config.fetchDetails(listing)).not.toHaveProperty('latitude');
  });

  it.each([403, 404, 429, 500])('keeps the card and does not invent a price on HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(response('Unavailable', status));
    expect(await config.fetchDetails(listing)).toBe(listing);
    expect(await config.priceTracking.probe(listing)).toBeNull();
  });

  it('checks active state and reads the same advertised price as the search card', async () => {
    fetchMock.mockResolvedValue(response(detailHtml));
    expect(await config.activityProbe(detailUrl)).toBe(1);
    expect(await config.priceTracking.probe(listing)).toBe(listing.price);
    const props = propsOf(detailHtml);
    props.targetPageProps.listingDetails.isActive = false;
    fetchMock.mockResolvedValue(response(render(props)));
    expect(await config.activityProbe(detailUrl)).toBe(0);
  });

  it.each([
    [404, 0],
    [410, 0],
    [403, -1],
    [429, -1],
    [500, -1],
  ])('treats HTTP %s as availability %s', async (status, expected) => {
    fetchMock.mockResolvedValue(response('', status));
    expect(await config.activityProbe(detailUrl)).toBe(expected);
  });

  it('does not use another advert after an unexpected redirect', async () => {
    const props = propsOf(detailHtml);
    props.targetPageProps.listingDetails.listingId = 123;
    fetchMock.mockResolvedValue(response(render(props)));
    expect(await config.fetchDetails(listing)).toBe(listing);
    expect(await config.activityProbe(detailUrl)).toBe(-1);
    expect(await config.priceTracking.probe(listing)).toBeNull();
  });

  it('treats network failures as unknown rather than removed', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));
    expect(await config.activityProbe(detailUrl)).toBe(-1);
    expect(await config.priceTracking.probe(listing)).toBeNull();
    expect(await config.fetchDetails(listing)).toBe(listing);
  });
});

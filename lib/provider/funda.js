/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash, isOneOf, sleep } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import { toListingImages } from '../utils/listingImages.js';
import puppeteerExtractor, { launchBrowser, closeBrowser } from '../services/extractor/puppeteerExtractor.js';
import { readSearchPage, readDetailPage } from '../services/funda/pageState.js';
import logger from '../services/logger.js';

/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const ORIGIN = 'https://www.funda.nl';
const MAX_PAGES = 100;
// The public search client's page offset is (page - 1) * 15.
const PAGE_SIZE = 15;

/**
 * Validate public residential search/detail URLs before opening a browser page.
 * @param {string} value A job URL or stored advert link.
 * @param {boolean} [detail] Whether an individual advert, rather than a search, is expected.
 * @returns {URL}
 */
function portalUrl(value, detail = false) {
  const url = new URL(value);
  const path = detail
    ? /^\/(?:en\/)?detail\/(?:koop|huur)\/[^/]+\/[^/]+\/\d+\/?$/
    : /^\/(?:en\/)?zoeken\/(?:koop|huur)\/?$/;
  if (
    url.protocol !== 'https:' ||
    !['funda.nl', 'www.funda.nl'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !path.test(url.pathname)
  ) {
    throw new Error(`Use a public Funda ${detail ? 'detail' : 'list-view search'} URL on https://www.funda.nl.`);
  }
  return url;
}

/**
 * Walk list-view pages through the job's shared Firefox browser. No personal browser profile, cookies or
 * tokens are read. A server refused by Funda fails explicitly rather than reporting zero matches.
 * Repeated adverts are deduplicated; a later refusal retains collected cards with a warning.
 * @param {string} value Original filtered search URL.
 * @param {import('puppeteer-core').Browser} [browser] The current job's browser.
 * @returns {Promise<any[]>} Public search records for normalization.
 */
async function getListings(value, browser) {
  const url = portalUrl(value);
  url.searchParams.set('sort', 'publish_date_sort_order_desc');
  const listings = [];
  const seen = new Set();
  const ownBrowser = !browser;
  try {
    if (ownBrowser) browser = await launchBrowser(url.href, { browserEngine: 'firefox' });
    for (let page = 1; page <= MAX_PAGES; page++) {
      url.searchParams.set('page', String(page));
      try {
        const html = await puppeteerExtractor(url.href, null, {
          browser,
          name: 'funda',
          waitForNetworkIdle: true,
          waitForNetworkIdleTimeout: 10_000,
        });
        if (!html)
          throw new Error(
            'Funda blocked or failed to load this search. A working normal browser does not guarantee access from Fredy; check the server/IP or proxy.',
          );
        const result = readSearchPage(html);
        if (result.page !== page) throw new Error(`Funda did not return requested page ${page}.`);
        const before = listings.length;
        for (const card of result.listings) {
          if (card.id == null || seen.has(card.id) || !card.object_detail_page_relative_url) continue;
          const link = new URL(card.object_detail_page_relative_url, ORIGIN).href;
          portalUrl(link, true);
          seen.add(card.id);
          listings.push({ ...card, link });
        }
        logger.info(
          `Funda: page ${page}/${Math.max(1, Math.ceil(result.total / PAGE_SIZE))}, ${listings.length} unique listings collected (portal total: ${result.total}).`,
        );
        if (result.listings.length === 0) {
          if (listings.length < result.total)
            logger.warn('Funda: empty page before the reported total; the search may be incomplete.');
          break;
        }
        if (listings.length === before) {
          if (!listings.length) throw new Error('Funda returned no usable listing links.');
          logger.warn('Funda: repeated or invalid page; the search may be incomplete.');
          break;
        }
        if (page * PAGE_SIZE >= result.total) break;
        if (page === MAX_PAGES) {
          logger.warn('Funda: stopped at the 100-page safety limit; narrow the search to collect the rest.');
          break;
        }
        await sleep(1500);
      } catch (error) {
        if (!listings.length) throw error;
        logger.warn(`Funda: incomplete search on page ${page}: ${error.message}`);
        break;
      }
    }
    return listings;
  } finally {
    if (ownBrowser) await closeBrowser(browser);
  }
}

/** @param {unknown} value A JSON number. @returns {number|null} Null for missing/nonfinite data. */
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Only a single quoted value is a precise price or size; project ranges are not one property's data.
 * @param {unknown} value A Funda array of numeric values.
 * @returns {number|null}
 */
function single(value) {
  return Array.isArray(value) && value.length === 1 ? numeric(value[0]) : null;
}

/**
 * Funda's public cloud-image provider uses image ids and a width option, not saved local filenames.
 * @param {unknown} id A public image id such as tiara-media/... or valentina_media/....
 * @returns {string|null}
 */
function photoUrl(id) {
  return typeof id === 'string' && id.length ? `https://cloud.funda.nl/${id}?options=width=720` : null;
}

/**
 * Normalize the advertised rent/purchase price and total rooms, never the bedroom count. The
 * public global id supplies stable identity even when Funda's canonical and search URL ids differ.
 * @param {any} raw A public search record with its validated detail link.
 * @returns {ParsedListing}
 */
function normalize(raw) {
  const price = single(raw.price?.rent_price ?? raw.price?.selling_price);
  const street = [raw.address?.street_name, raw.address?.house_number, raw.address?.house_number_suffix]
    .filter(Boolean)
    .join(' ');
  const publishedAt = Date.parse(raw.publish_date);
  return {
    id: buildHash(raw.id == null ? null : String(raw.id), price == null ? null : String(price)),
    link:
      raw.link ||
      (raw.object_detail_page_relative_url
        ? portalUrl(new URL(raw.object_detail_page_relative_url, ORIGIN).href, true).href
        : null),
    title: street || '',
    address: [street, raw.address?.postal_code, raw.address?.city].filter(Boolean).join(', '),
    price,
    size: single(raw.floor_area),
    rooms: numeric(raw.number_of_rooms),
    image: photoUrl(raw.photo_image_id?.[0]),
    images: toListingImages((Array.isArray(raw.photo_image_id) ? raw.photo_image_id : []).map(photoUrl)),
    description: '',
    ...(raw.energy_label ? { energyClass: raw.energy_label } : {}),
    ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
  };
}

/**
 * Find a public feature by its stable id rather than its translated label.
 * @param {any[]} [features] Nested Funda feature groups.
 * @param {string} id Feature id to find.
 * @returns {string|null}
 */
function featureValue(features, id) {
  for (const feature of Array.isArray(features) ? features : []) {
    if (feature.Id === id) return feature.Value || null;
    const nested = featureValue(feature.KenmerkenList, id);
    if (nested) return nested;
  }
  return null;
}

/**
 * Fetch only the requested advert's cached public state. Never replace a search URL with Funda's
 * canonical URL: real adverts can carry different ids in the two places.
 * @param {string} link Public detail link.
 * @param {import('puppeteer-core').Browser} [browser] Shared browser.
 * @returns {Promise<any|null>}
 */
async function detailOf(link, browser) {
  portalUrl(link, true);
  const html = await puppeteerExtractor(link, null, {
    browser,
    browserEngine: 'firefox',
    name: 'funda_details',
    waitForNetworkIdle: true,
    waitForNetworkIdleTimeout: 10_000,
  });
  return html ? readDetailPage(html, link) : null;
}

/**
 * Enrich new adverts with description, coordinates, gallery, total rooms and build year. A failed
 * detail fetch leaves the usable search card intact, including its original price and link.
 * @param {ParsedListing} listing Normalized card.
 * @param {import('puppeteer-core').Browser} [browser] Shared browser.
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing, browser) {
  try {
    const detail = await detailOf(listing.link, browser);
    if (!detail) return listing;
    const enriched = {
      ...listing,
      description: detail.description?.content || listing.description,
      rooms: extractNumber(featureValue(detail.features, 'indeling-totalrooms')) ?? listing.rooms,
      images: toListingImages(
        (detail.media?.photos?.items ?? []).map((item) => ({
          url: detail.media.photos.mediaBaseUrl?.replace('{id}', item.id),
          caption: item.displayName || '',
        })),
      ),
    };
    const year = extractNumber(featureValue(detail.features, 'bouw-bouwjaar'));
    if (year !== null) enriched.buildYear = year;
    if (numeric(detail.coordinates?.lat) !== null && numeric(detail.coordinates?.lng) !== null) {
      enriched.latitude = detail.coordinates.lat;
      enriched.longitude = detail.coordinates.lng;
    }
    return enriched;
  } catch (error) {
    logger.warn(`Funda: could not enrich listing ${listing.id}: ${error.message}`);
    return listing;
  }
}

/**
 * Only a real 404/410 or the advert's explicit sold/rented flag means inactive. A blocked or
 * unfamiliar page means unknown. Always close the page, leaving the shared browser to its owner.
 * @param {string} link Stored advert URL.
 * @param {import('puppeteer-core').Browser} browser Alive-checker's shared browser.
 * @returns {Promise<number>} 1 active, 0 gone, -1 unknown.
 */
async function browserActivityProbe(link, browser) {
  portalUrl(link, true);
  let page;
  try {
    page = await browser.newPage();
    const response = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const status = response?.status();
    if (status === 404 || status === 410) return 0;
    if (status !== 200) return -1;
    const detail = readDetailPage(await page.content(), link);
    return typeof detail?.isSoldOrRented === 'boolean' ? (detail.isSoldOrRented ? 0 : 1) : -1;
  } catch {
    return -1;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** @type {ProviderConfig} */
const config = {
  browserEngine: 'firefox',
  url: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  crawlFields: {},
  sortByDateParam: 'sort=publish_date_sort_order_desc',
  priceRangeParams: {
    parse: (value) => {
      const [min, max] = (new URL(value).searchParams.get('price') || '').replaceAll('"', '').split('-');
      return { min, max };
    },
  },
  getListings,
  normalize,
  fetchDetails,
  detailFetchDelayMs: 1500,
  browserActivityProbe,
  priceTracking: {
    browserProbe: async (listing, browser) => {
      try {
        return numeric((await detailOf(listing.link, browser))?.price?.numericPrice);
      } catch {
        return null;
      }
    },
  },
};

/**
 * Build an independent configuration for a current public Funda residential list-view search.
 * All original filters are retained. Grouped projects/map and legacy URLs are refused rather than
 * silently widened. Access depends on Funda accepting Fredy's server/browser, not a personal login.
 * @param {{url: string, enabled?: boolean}} sourceConfig This job's provider settings.
 * @param {string[]} [blacklist] Terms excluded from titles/descriptions.
 * @returns {ProviderConfig}
 */
export function createConfig(sourceConfig, blacklist = []) {
  const url = portalUrl(sourceConfig.url);
  const type = url.searchParams.get('type');
  if (
    (type && type.replaceAll('[', '').replaceAll(']', '').replaceAll('"', '') !== 'single') ||
    url.searchParams.get('collapse_projects') === 'true'
  ) {
    throw new Error('Funda supports individual adverts only; disable grouped projects in the search.');
  }
  return {
    ...config,
    url: sourceConfig.url,
    enabled: sourceConfig.enabled,
    filter: (listing) => !isOneOf(listing.title, blacklist ?? []) && !isOneOf(listing.description, blacklist ?? []),
  };
}

export const metaInformation = { id: 'funda', name: 'Funda (experimental)', baseUrl: ORIGIN, countries: ['nl'] };
export { config };

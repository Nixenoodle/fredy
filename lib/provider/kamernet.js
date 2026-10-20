/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf, sleep } from '../utils.js';
import logger from '../services/logger.js';
import { toListingImages } from '../utils/listingImages.js';

/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const ORIGIN = 'https://kamernet.nl';
const MAX_PAGES = 100;

/**
 * Guard all requests, including redirects and stored detail links. Only public Kamernet pages are
 * fetched, never a landlord's external URL, an authenticated endpoint or a different origin.
 * @param {string|URL} value A pasted, redirected or stored URL.
 * @returns {URL} A validated HTTPS URL.
 */
function portalUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['kamernet.nl', 'www.kamernet.nl'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error('Kamernet URLs must use https://kamernet.nl.');
  }
  return url;
}

/**
 * Fetch the public server-rendered Next.js state. Missing/challenged/malformed pages are not empty
 * searches. Follow only same-portal redirects (the site canonicalises old search URLs this way).
 * @param {string|URL} value Public search or detail URL.
 * @returns {Promise<{props: any, target: any, $: import('cheerio').CheerioAPI}|null>}
 *   Null only when Kamernet explicitly returns 404/410 or its own not-found state.
 */
async function readPage(value) {
  let url = portalUrl(value);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(url.href, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Kamernet returned a redirect without a destination.');
      url = portalUrl(new URL(location, url));
      continue;
    }
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Kamernet returned HTTP ${response.status}.`);
    const $ = cheerio.load(await response.text());
    const raw = $('#__NEXT_DATA__').text();
    if (!raw) throw new Error('Kamernet returned no listing state; it may be blocking this server.');
    const props = JSON.parse(raw)?.props?.pageProps;
    if (props?.hasError404) return null;
    if (props?.hasError500 || !props?.targetPageProps) throw new Error('Kamernet returned an unavailable page.');
    return { props, target: props.targetPageProps, $ };
  }
  throw new Error('Kamernet returned too many redirects.');
}

/**
 * Walk public search pages, preserving every filter and resetting a pasted page number to one.
 * Only matching listings and promoted matching listings are included, not `nearbyListings`
 * recommendations. The website's page size and total control the walk; repeated ids/pages and a
 * safety cap stop a broken pager. A later failure preserves collected cards with a warning.
 * @param {string} value This run's search URL.
 * @returns {Promise<any[]>} Raw public cards with their rendered detail links.
 */
async function getListings(value) {
  const url = portalUrl(value);
  url.searchParams.set('sort', '1');
  const listings = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    url.searchParams.set('pageNo', String(page));
    try {
      const state = await readPage(url);
      const result = state?.target?.findListingsResponse;
      if (!result || !Array.isArray(result.listings) || result.OpResponse?.Code !== 1000) {
        throw new Error('Kamernet returned no valid search results. Paste a list-view search URL from the portal.');
      }
      if (state.target.allFilters?.pageNo !== page) throw new Error(`Kamernet did not return requested page ${page}.`);
      const perPage = state.target.allFilters.listingsPerPage;
      const total = result.total;
      if (!Number.isInteger(perPage) || perPage <= 0 || !Number.isInteger(total) || total < 0) {
        throw new Error('Kamernet returned invalid pagination metadata.');
      }
      const links = new Map();
      state.$('a[href]').each((_, element) => {
        const href = state.$(element).attr('href');
        const match = href.match(
          /\/(?:room|kamer|apartment|appartement|studio|anti-squat|antikraak|student-housing|studentenhuis)-(\d+)(?:[?#]|$)/,
        );
        if (match) links.set(Number(match[1]), new URL(href, ORIGIN).href);
      });
      const before = listings.length;
      for (const card of [...(result.topAdListings ?? []), ...result.listings]) {
        if (!Number.isSafeInteger(card?.listingId) || seen.has(card.listingId)) continue;
        const link = links.get(card.listingId);
        if (!link) continue;
        portalUrl(link);
        seen.add(card.listingId);
        listings.push({ ...card, link });
      }
      logger.info(
        `Kamernet: page ${page}/${Math.max(1, Math.ceil(total / perPage))}, ${listings.length} unique listings collected (portal total: ${total}).`,
      );
      if (result.listings.length === 0) {
        if (listings.length < total)
          logger.warn('Kamernet: empty page before the reported total; the search may be incomplete.');
        break;
      }
      if (listings.length === before) {
        if (!listings.length) throw new Error('Kamernet returned cards without usable listing links.');
        logger.warn('Kamernet: stopped on a repeated/invalid page; the search may be incomplete.');
        break;
      }
      if (page * perPage >= total) break;
      if (page === MAX_PAGES) {
        logger.warn(`Kamernet: stopped at the ${MAX_PAGES}-page safety limit; narrow the search to collect the rest.`);
        break;
      }
      await sleep(500);
    } catch (error) {
      if (!listings.length) throw error;
      logger.warn(`Kamernet: incomplete search on page ${page}: ${error.message}`);
      break;
    }
  }
  return listings;
}

/**
 * Normalize numeric public card fields without guessing bedroom counts. A room advert is one
 * room; an apartment's room count is unknown until its detail page states it. `totalRentalPrice`
 * is the advertised figure; `utilitiesIncluded` records whether it already includes charges.
 * @param {any} raw A public search card.
 * @returns {ParsedListing}
 */
function normalize(raw) {
  return {
    id: buildHash(
      raw.listingId == null ? null : String(raw.listingId),
      raw.totalRentalPrice == null ? null : String(raw.totalRentalPrice),
    ),
    link: raw.link || null,
    title: [raw.street, raw.city].filter(Boolean).join(', '),
    price: numeric(raw.totalRentalPrice),
    size: numeric(raw.surfaceArea),
    rooms: raw.listingType === 1 ? 1 : null,
    address: [raw.street, raw.city].filter(Boolean).join(', '),
    image: raw.fullPreviewImageUrl || raw.thumbnailUrl || null,
    description: '',
    ...(typeof raw.utilitiesIncluded === 'boolean' ? { chargesIncluded: raw.utilitiesIncluded } : {}),
  };
}

/** @param {unknown} value A JSON number. @returns {number|null} No fabricated zero for missing data. */
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A redirected or stale page must never supply another advert's price, description or availability.
 * @param {any} state The parsed public page.
 * @param {string} link The requested advert URL.
 * @returns {any|null} Only the detail matching the requested id.
 */
function detailOf(state, link) {
  const detail = state?.target?.listingDetails;
  const id = new URL(link).pathname.match(/-(\d+)\/?$/)?.[1];
  return detail && id && String(detail.listingId) === id ? detail : null;
}

/**
 * Fetch the public description, full address, postcode coordinates and gallery for a new listing.
 * No landlord profile/contact fields are copied. Keep the card if the advert cannot be read.
 * @param {ParsedListing} listing A normalized search card.
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  try {
    const state = await readPage(listing.link);
    const detail = detailOf(state, listing.link);
    if (!detail) return listing;
    const english = state.props.locale === 'en';
    const street = [detail.computedStreetName, detail.houseNumber, detail.houseNumberAddition]
      .filter(Boolean)
      .join(' ');
    const description =
      (english ? detail.englishDescription : detail.dutchDescription) ||
      detail.dutchDescription ||
      detail.englishDescription;
    const enriched = {
      ...listing,
      title: (english ? detail.englishTitle : detail.dutchTitle) || listing.title,
      description: description || listing.description,
      address: [street, detail.postalCode, detail.computedCityName].filter(Boolean).join(', ') || listing.address,
      rooms: numeric(detail.numOfRooms) ?? listing.rooms,
      images: toListingImages(
        (Array.isArray(detail.imageList) ? detail.imageList : [])
          .filter((id) => typeof id === 'string')
          .map((id) => `https://resources.kamernet.nl/image/${encodeURIComponent(id)}`),
      ),
    };
    if (numeric(detail.postalCodeLat) !== null && numeric(detail.postalCodeLong) !== null) {
      enriched.latitude = detail.postalCodeLat;
      enriched.longitude = detail.postalCodeLong;
    }
    return enriched;
  } catch (error) {
    logger.warn(`Kamernet: could not enrich listing ${listing.id}: ${error.message}`);
    return listing;
  }
}

/**
 * Read only explicit availability. A 403, network error or unfamiliar page is unknown, not gone.
 * @param {string} link A stored detail URL.
 * @returns {Promise<number>} 1 active, 0 gone, -1 unknown.
 */
async function activityProbe(link) {
  try {
    const state = await readPage(link);
    if (!state) return 0;
    const detail = detailOf(state, link);
    if (typeof detail?.isActive !== 'boolean') return -1;
    return detail.isActive ? 1 : 0;
  } catch {
    return -1;
  }
}

/**
 * `maxRent` is Kamernet's dropdown enum, not euros: 10 means €1000 and 17 means €2000.
 * @param {string} value A search URL.
 * @returns {{min: null, max: number|null}} The euro ceiling, or unknown for no/invalid selection.
 */
function priceRange(value) {
  const code = Number(new URL(value).searchParams.get('maxRent'));
  const max =
    Number.isInteger(code) && code >= 1 && code <= 15
      ? code * 100
      : Number.isInteger(code) && code >= 16 && code <= 33
        ? 1500 + (code - 15) * 250
        : code === 34
          ? 20000
          : null;
  return { min: null, max };
}

/** @type {ProviderConfig} */
const config = {
  url: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  crawlFields: {},
  sortByDateParam: 'sort=1',
  priceRangeParams: { parse: priceRange },
  getListings,
  normalize,
  fetchDetails,
  detailFetchDelayMs: 500,
  activityProbe,
  priceTracking: {
    probe: async (listing) => {
      try {
        return numeric(detailOf(await readPage(listing.link), listing.link)?.totalRentalPrice);
      } catch {
        return null;
      }
    },
  },
};

/**
 * Build an independent config for a public English or Dutch list-view search. All portal filters
 * remain on the URL. No accounts, tokens or authenticated API endpoints are used.
 * @param {{url: string, enabled?: boolean}} sourceConfig The job's provider settings.
 * @param {string[]} [blacklist] Terms excluded from titles and descriptions.
 * @returns {ProviderConfig}
 */
export function createConfig(sourceConfig, blacklist = []) {
  const url = portalUrl(sourceConfig.url);
  if (
    !/^(?:\/en\/for-rent|\/huren)\/[^/]+(?:\/[^/]+)?\/?$/.test(url.pathname) ||
    (url.searchParams.has('searchView') && !['1', '0'].includes(url.searchParams.get('searchView')))
  ) {
    throw new Error('Paste a Kamernet list-view search URL, such as https://kamernet.nl/en/for-rent/room-rotterdam.');
  }
  return {
    ...config,
    url: sourceConfig.url,
    enabled: sourceConfig.enabled,
    filter: (listing) => !isOneOf(listing.title, blacklist ?? []) && !isOneOf(listing.description, blacklist ?? []),
  };
}

export const metaInformation = {
  id: 'kamernet',
  name: 'Kamernet',
  baseUrl: ORIGIN,
  countries: ['nl'],
};

export { config };

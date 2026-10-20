/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash, isOneOf, sleep } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import puppeteerExtractor, { launchBrowser, closeBrowser } from '../services/extractor/puppeteerExtractor.js';
import * as cheerio from 'cheerio';
import { parse } from '../services/extractor/parser/parser.js';
import { botDetected } from '../services/extractor/utils.js';
import logger from '../services/logger.js';

/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

export const metaInformation = {
  id: 'pararius',
  name: 'Pararius',
  baseUrl: 'https://www.pararius.nl',
  hosts: ['pararius.nl', 'pararius.com'],
  countries: ['nl'],
};

/**
 * Pararius puts the euro sign before the number. The English site uses comma thousands separators,
 * the Dutch site uses dots. Do not pass English prices to the shared German decimal parser.
 * @param {string|null|undefined} value Rendered price, area or room count.
 * @param {boolean} english Whether this is a pararius.com search.
 * @returns {number|null}
 */
function numberOf(value, english) {
  const numeric = value?.replace(/[^\d.,]/g, '');
  return extractNumber(english ? numeric?.replaceAll(',', '') : numeric);
}

/**
 * Normalize a card using this run's origin, so Dutch links stay Dutch and English links stay English.
 * Hash the advert path and price, not the translated title or hostname.
 * @param {any} raw Parsed search card.
 * @param {string} searchUrl This job's search URL.
 * @returns {ParsedListing}
 */
function normalize(raw, searchUrl) {
  const english = new URL(searchUrl).hostname.endsWith('pararius.com');
  const price = numberOf(raw.price, english);
  return {
    id: buildHash(raw.id, price),
    title: raw.title || '',
    link: raw.link ? new URL(raw.link, searchUrl).href : null,
    price,
    size: numberOf(raw.size, english),
    rooms: numberOf(raw.rooms, english),
    address: [raw.title?.replace(/^\S+\s+/, ''), raw.address].filter(Boolean).join(', '),
    image: raw.image ? new URL(raw.image, searchUrl).href : null,
    description: raw.description || '',
  };
}

/**
 * Walk the search's next-page links, starting at page one even when a later page was pasted.
 * Reuse one browser and pace requests. Deduplicate promoted adverts repeated across pages, and stop
 * on empty/repeated pages or after 100 pages. Keep collected cards if a later page is blocked and
 * warn about the incomplete search. Below-the-fold photos are unwrapped from inert templates.
 * @param {string} url The original, filtered search URL.
 * @param {import('puppeteer-core').Browser} [browser] This run's shared browser.
 * @returns {Promise<any[]>} Raw cards for the pipeline's normalizer.
 */
async function getListings(url, browser) {
  const first = new URL(url);
  first.pathname = first.pathname.replace(/\/page-\d+\/?$/, '').replace(/\/$/, '');
  const listings = [];
  const seenIds = new Set();
  const visited = new Set();
  let current = first;
  const ownBrowser = !browser;
  try {
    if (ownBrowser) browser = await launchBrowser(first.href);
    for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
      if (visited.has(current.href)) break;
      visited.add(current.href);
      let html;
      try {
        html = await puppeteerExtractor(current.href, null, {
          browser,
          name: 'pararius',
          waitForNetworkIdle: true,
          waitForNetworkIdleTimeout: 10_000,
        });
        if (!html) throw new Error('Pararius could not be loaded; the site may be blocking this server.');
      } catch (error) {
        if (!listings.length) throw error;
        logger.warn(`Pararius: incomplete search, could not load ${current.href}: ${error.message}`);
        break;
      }
      const $ = cheerio.load(html);
      $('.listing-search-item template').each((_, element) => {
        $(element).replaceWith($(element).html() || '');
      });
      const cards = parse(config.crawlContainer, config.crawlFields, $.html(), current.href) ?? [];
      const previousCount = listings.length;
      for (const card of cards) {
        if (seenIds.has(card.id)) continue;
        seenIds.add(card.id);
        listings.push(card);
      }
      if (listings.length === previousCount) break;
      const nextLink = $('.pagination__link--next[href], link[rel="next"][href]').first().attr('href');
      if (!nextLink) break;
      const next = new URL(nextLink, current);
      // Never follow a pagination link into another site or a different/wider search.
      if (next.origin !== first.origin || next.pathname.replace(/\/page-\d+\/?$/, '') !== first.pathname) break;
      for (const key of new Set(first.searchParams.keys())) {
        next.searchParams.delete(key);
        for (const value of first.searchParams.getAll(key)) next.searchParams.append(key, value);
      }
      next.hash = '';
      if (visited.has(next.href)) break;
      if (pageNumber === 100) {
        logger.warn('Pararius: stopped at the 100-page safety limit; narrow the search to collect the rest.');
        break;
      }
      current = next;
      await sleep(1500);
    }
    return listings;
  } finally {
    if (ownBrowser) await closeBrowser(browser);
  }
}

/**
 * Search cards have no description. Fetch it only for new listings, using the job's shared browser:
 * ordinary HTTP requests to both Pararius domains are challenged by Cloudflare.
 * @param {ParsedListing} listing Normalized card.
 * @param {import('puppeteer-core').Browser} [browser] The current job's browser.
 * @returns {Promise<ParsedListing>} Keep the card unchanged if the detail page is unavailable.
 */
async function fetchDetails(listing, browser) {
  try {
    const html = await puppeteerExtractor(listing.link, null, { browser, name: 'pararius_details' });
    if (!html) return listing;
    const $ = cheerio.load(html);
    const description = $('.listing-detail-description__additional p')
      .map((_, element) => $(element).text().replace(/\s+/g, ' ').trim())
      .get()
      .join('\n\n');
    return description ? { ...listing, description } : listing;
  } catch {
    return listing;
  }
}

/**
 * Check availability in a browser rather than mistaking a plain HTTP challenge for a removed ad.
 * Only an explicit 404/410 means gone; a challenge or an unfamiliar page means unknown.
 * @param {string} link The stored advert URL.
 * @param {import('puppeteer-core').Browser} browser The alive-checker's shared browser.
 * @returns {Promise<number>} 1 active, 0 gone, -1 unknown.
 */
async function browserActivityProbe(link, browser) {
  let page;
  try {
    page = await browser.newPage();
    const response = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const status = response?.status();
    if (status === 404 || status === 410) return 0;
    if (status !== 200) return -1;
    const html = await page.content();
    if (botDetected(html, status)) return -1;
    const $ = cheerio.load(html);
    return $('.listing-detail-summary').length ? 1 : -1;
  } catch {
    return -1;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** @type {ProviderConfig} */
const config = {
  url: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  crawlContainer: '.listing-search-item',
  crawlFields: {
    id: '.listing-search-item__link--title@href',
    link: '.listing-search-item__link--title@href',
    title: '.listing-search-item__title | trim',
    price:
      '.listing-search-item__price-main, .listing-search-item__price-bare .listing-search-item__price-value | trim',
    address: '.listing-search-item__sub-title | trim',
    size: '.illustrated-features__item--surface-area | trim',
    rooms: '.illustrated-features__item--number-of-rooms | trim',
    image: '.listing-search-item__depiction img:not([src^="data:"])@src',
    description: '.illustrated-features__item--interior | trim',
  },
  // Newest first is Pararius's default. Keep the portal's date sorting when copying a search URL.
  sortByDateParam: null,
  waitForSelector: null,
  priceRangeParams: {
    parse: (url) => {
      const match = new URL(url).pathname.match(/^\/(?:huurwoningen|apartments)\/[^/]+\/(\d+)-(\d+)(?:\/|$)/);
      return { min: match?.[1], max: match?.[2] };
    },
  },
  normalize: (raw) => normalize(raw, metaInformation.baseUrl),
  getListings,
  fetchDetails,
  browserActivityProbe,
};

/**
 * Create an independent config for a Dutch or English Pararius search. Path-based filters (including
 * rent bounds) are passed through untouched, rather than translated into a different search.
 * @param {{url: string, enabled?: boolean}} sourceConfig This job's provider settings.
 * @param {string[]} [blacklist] Terms excluded from titles and descriptions.
 * @returns {ProviderConfig} A run-scoped provider config.
 */
export function createConfig(sourceConfig, blacklist = []) {
  const url = new URL(sourceConfig.url);
  if (url.protocol !== 'https:' || !metaInformation.hosts.includes(url.hostname.replace(/^www\./, ''))) {
    throw new Error('Pararius searches must use https://www.pararius.nl or https://www.pararius.com.');
  }
  return {
    ...config,
    url: sourceConfig.url,
    enabled: sourceConfig.enabled,
    normalize: (raw) => normalize(raw, sourceConfig.url),
    filter: (listing) => !isOneOf(listing.title, blacklist ?? []) && !isOneOf(listing.description, blacklist ?? []),
  };
}

export { config };

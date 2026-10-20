/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';

/**
 * Read Funda's inert Nuxt JSON, whose integers refer to entries in a flattened value table.
 * No script is executed. Only JSON objects/arrays, primitives and Nuxt's reactive wrappers are
 * decoded; unsupported tagged values become null. Null-prototype objects prevent `__proto__`
 * keys from changing prototypes. The table/cache also allows shared references and cycles.
 *
 * @param {string} html A public Funda page, never a browser profile or cookies.
 * @returns {any} The decoded state; callers select public listing fields, not account state.
 * @throws {Error} If a challenge, malformed payload or unsupported page contains no usable state.
 */
export function readPageState(html) {
  const raw = cheerio.load(html)('#__NUXT_DATA__').text();
  if (!raw) throw new Error('Funda returned no listing data; the page may be blocked.');
  const table = JSON.parse(raw);
  if (!Array.isArray(table) || !table.length) throw new Error('Funda returned invalid Nuxt data.');
  const cache = new Map();
  const wrappers = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef']);
  const decode = (index, depth = 0) => {
    if (index === -1) return undefined;
    if (!Number.isInteger(index) || index < 0 || index >= table.length || depth > 100) return null;
    if (cache.has(index)) return cache.get(index);
    const value = table[index];
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') {
      cache.set(index, null);
      const decoded = wrappers.has(value[0]) ? decode(value[1], depth + 1) : null;
      cache.set(index, decoded);
      return decoded;
    }
    const result = Array.isArray(value) ? [] : Object.create(null);
    cache.set(index, result);
    for (const [key, reference] of Object.entries(value)) result[key] = decode(reference, depth + 1);
    return result;
  };
  return decode(0);
}

/**
 * Public list-view records and pagination only. A missing result store is not an empty search.
 * @param {string} html The rendered search page.
 * @returns {{listings: any[], total: number, page: number}}
 */
export function readSearchPage(html) {
  const search = readPageState(html)?.pinia?.search;
  if (
    !Array.isArray(search?.listings) ||
    !Number.isInteger(search.totalListingsCount) ||
    search.totalListingsCount < 0 ||
    !Number.isInteger(search.criteria?.page)
  ) {
    throw new Error('Funda returned no valid search results; check access and use a list-view search URL.');
  }
  return { listings: search.listings, total: search.totalListingsCount, page: search.criteria.page };
}

/**
 * Match the requested advert by the cache key's public URL id. The canonical URL is deliberately
 * not used: the supplied real page's canonical id differs from the id the search links to.
 * @param {string} html A rendered advert.
 * @param {string} link The requested public detail link.
 * @returns {any|null} Only that advert's public cached data, not suggested properties.
 */
export function readDetailPage(html, link) {
  const id = new URL(link).pathname.match(/\/(\d+)\/?$/)?.[1];
  if (!id) return null;
  const data = readPageState(html)?.data;
  const key = Object.keys(data ?? {}).find(
    (name) => name === `cachedListingData_nl_${id}` || name === `cachedListingData_en_${id}`,
  );
  return key ? data[key] : null;
}

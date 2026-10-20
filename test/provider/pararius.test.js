/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect, it } from 'vitest';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { createConfig, metaInformation } from '../../lib/provider/pararius.js';

it('runs Pararius through the listing and notification pipeline', async () => {
  const Fredy = await mockFredy();
  const job = { id: 'pararius', notificationAdapter: null, spatialFilter: null, specFilter: null };
  const fredy = new Fredy(createConfig(providerConfig.pararius), job, metaInformation.id, similarityCache);
  const listings = await fredy.execute();
  expect(listings?.length).toBeGreaterThan(0);
  expect(get().serviceName).toBe('pararius');
  for (const listing of listings) {
    expect(listing.price).toBeGreaterThan(100);
    expect(listing.link).toMatch(/^https:\/\/www\.pararius\.com\//);
    expect(listing.title).not.toBe('');
    expect(listing.address).not.toBe('');
  }
}, 300_000);

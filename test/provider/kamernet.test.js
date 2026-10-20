/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect, it } from 'vitest';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { createConfig, metaInformation } from '../../lib/provider/kamernet.js';

it('runs all Kamernet pages through the listing and notification pipeline', async () => {
  const Fredy = await mockFredy();
  const job = { id: 'kamernet', notificationAdapter: null, spatialFilter: null, specFilter: null };
  const fredy = new Fredy(createConfig(providerConfig.kamernet), job, metaInformation.id, similarityCache);
  const listings = await fredy.execute();
  expect(listings?.length).toBeGreaterThan(0);
  if (process.env.TEST_MODE === 'offline') expect(listings).toHaveLength(3);
  expect(get().serviceName).toBe('kamernet');
  for (const listing of listings) {
    expect(listing.id).toMatch(/^[a-f0-9]{64}$/);
    expect(listing.price).toBeGreaterThan(0);
    expect(listing.link).toMatch(/^https:\/\/kamernet\.nl\//);
    expect(listing.title).not.toBe('');
    expect(listing.address).not.toBe('');
  }
}, 180_000);

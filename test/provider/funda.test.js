/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect, it } from 'vitest';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { createConfig, metaInformation } from '../../lib/provider/funda.js';

// Fixture coverage is not live proof: Funda also depends on the deployment's browser/network route.
it.skipIf(process.env.TEST_MODE !== 'offline')(
  'runs sanitized Funda browser snapshots through the pipeline',
  async () => {
    const Fredy = await mockFredy();
    const job = { id: 'funda', notificationAdapter: null, spatialFilter: null, specFilter: null };
    const listings = await new Fredy(
      createConfig(providerConfig.funda),
      job,
      metaInformation.id,
      similarityCache,
    ).execute();
    expect(listings).toHaveLength(2);
    expect(get().serviceName).toBe('funda');
    expect(listings[0]).toMatchObject({ price: 1922, rooms: 4, size: 92 });
    // Detail fetching is opt-in per user; the unit suite exercises the enrichment separately.
    expect(listings[0].description).toBe('');
    expect(listings[0].link).toContain('/80904808/');
  },
);

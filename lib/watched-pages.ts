import type { Brand } from '@/lib/queries/orders';

// Pages the team explicitly wants to monitor regardless of revenue rank.
// Order in this array = order in the Watched Pages tab.
//
// Use normalized paths (no query strings). Match what `SPLIT_PART(LANDING_SITE, '?', 1)`
// produces on the Snowflake side. A page with zero orders in the period still
// renders as a $0 row — that's the signal: "this page we're watching isn't moving."
//
// To add/remove a page: edit this array, open a PR, merge. Vercel auto-deploys.

export const WATCHED_PAGES: Record<Brand, string[]> = {
  ASN: [
    '/products/copper-peptides-serum',
    '/',
    '/products/snail-mucin-essence',
    '/collections/best-sellers',
  ],
  HHH: [
    '/',
    '/collections/all',
  ],
  VIV: [
    '/products/multi-collagen-pills',
    '/',
    '/collections/all',
  ],
  PRL: [
    '/products/thermogenic-burner',
    '/',
    '/collections/all',
  ],
};

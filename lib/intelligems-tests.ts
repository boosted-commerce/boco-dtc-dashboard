import type { Brand } from '@/lib/queries/orders';

// Manually-maintained list of active Intelligems tests per brand.
// When a test ends, delete its entry (or move to an archive).
//
// To add a test:
//   1. Open the test in Intelligems → copy the URL from the address bar
//   2. Note the test ID (the UUID after /experiment/)
//   3. List the origin URLs (the "Redirect When URL" values from
//      Modifications tab) — paths only, no host
//   4. List the destination URLs (the "Redirect" target) — paths only
//   5. Add the entry below

export type IntelligemsTest = {
  name: string;
  testUrl: string;     // deep link to the test in Intelligems
  origins: string[];   // landing URLs that trigger the test (paths only)
  destinations: string[]; // redirect target URLs (paths only)
};

export const INTELLIGEMS_TESTS: Record<Brand, IntelligemsTest[]> = {
  ASN: [],
  HHH: [],
  VIV: [
    {
      name: 'Split URL Test · May 19',
      testUrl:
        'https://app.intelligems.io/experiment/4463b80f-b4f5-4d4c-b85f-a4d5b037d247',
      origins: [
        '/products/collagen',
        '/products/chlorophyll-complex',
        '/pages/multi-collagen-complex-plus-01',
        '/products/vital-vitamin-multi-collagen',
      ],
      destinations: [
        '/pages/multi-collagen-complex',
        '/pages/chlorophyll-complex',
        '/pages/multi-collagen-complex-plus',
      ],
    },
  ],
  PRL: [],
};

// Returns the test (and role) that a given path participates in, or
// null if the path isn't in any active test for this brand.
//
// Role distinguishes the redirect FROM page (origin) vs the variant
// page that paid traffic is redirected TO (destination) — both should
// surface the badge but the tooltip text differs.
export function findIntelligemsTest(
  brand: Brand,
  path: string,
): { test: IntelligemsTest; role: 'origin' | 'destination' } | null {
  const tests = INTELLIGEMS_TESTS[brand] ?? [];
  for (const test of tests) {
    if (test.origins.includes(path)) return { test, role: 'origin' };
    if (test.destinations.includes(path)) return { test, role: 'destination' };
  }
  return null;
}

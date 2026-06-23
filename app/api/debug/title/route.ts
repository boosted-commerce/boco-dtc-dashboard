import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getShopifyCredentials } from '@/lib/watched-store';
import { SHOPIFY_API_VERSION } from '@/lib/shopify-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Diagnose why an exact page title isn't resolving:
//   /api/debug/title?brand=VIV&path=/products/<handle>
// Returns the raw Admin GraphQL response (incl. any scope errors) so we
// can see whether it's a scope issue, a wrong handle, or a query problem.
export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;
  const brand = parseBrand(sp.get('brand'));
  const path = sp.get('path') ?? '';
  const creds = await getShopifyCredentials(brand);
  if (!creds) return Response.json({ error: 'no Shopify credentials for brand', brand });

  const segs = path.split('?')[0].split('/').filter(Boolean);
  const type = segs[0];
  const handle = segs[segs.length - 1] ?? '';
  const field =
    type === 'products' ? 'products' : type === 'collections' ? 'collections' : type === 'pages' ? 'pages' : null;
  if (!field) return Response.json({ error: 'unsupported path type', type, path });

  const res = await fetch(
    `https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': creds.token },
      body: JSON.stringify({
        query: `query($q:String!){ ${field}(first:1, query:$q){ nodes{ title handle } } }`,
        variables: { q: `handle:${handle}` },
      }),
      cache: 'no-store',
    },
  );
  const json = await res.json().catch(() => ({ parseError: true }));
  return Response.json({ brand, shop: creds.shop, field, handle, status: res.status, json });
}

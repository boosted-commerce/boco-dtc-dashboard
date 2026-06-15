import { type NextRequest } from 'next/server';
import { parseBrand } from '@/lib/queries/orders';
import { getTodayOrders, getTodaySessions, getTodayOrdersSample } from '@/lib/shopify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Verify today's live figures + subscription auto-detection for a brand:
//   /api/debug/today?brand=VIV
// Returns the tally (orders/revenue + subscription split), today's
// sessions/conv, and a sample of orders with their raw Recharge signals
// so we can confirm the classification against real data.
export async function GET(request: NextRequest) {
  const brand = parseBrand(new URL(request.url).searchParams.get('brand'));
  const [orders, sessions, sample] = await Promise.all([
    getTodayOrders(brand).catch((e) => ({ error: String(e) })),
    getTodaySessions(brand).catch((e) => ({ error: String(e) })),
    getTodayOrdersSample(brand).catch((e) => ({ error: String(e) })),
  ]);
  return Response.json({ brand, orders, sessions, sample });
}

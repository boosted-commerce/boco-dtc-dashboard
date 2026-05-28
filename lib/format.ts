// Shared metric formatter. Single-sourced so the cards and the
// interactive sparkline tooltip render identical values.
export type Format = 'count' | 'currency' | 'aov' | 'percent';

export const fmt = (n: number, kind: Format): string => {
  if (kind === 'count') return Math.round(n).toLocaleString();
  if (kind === 'currency')
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (kind === 'aov')
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${n.toFixed(1)}%`;
};

// Format a YYYY-MM-DD daily-point date as e.g. "Wed May 25" for the
// sparkline tooltip / peak label. Parsed as local noon to avoid the
// off-by-one that bites when a UTC-midnight date shifts a day in
// negative timezones.
export const fmtDayLabel = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

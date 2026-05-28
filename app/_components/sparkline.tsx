'use client';

import { useRef, useState } from 'react';
import { fmt, fmtDayLabel, type Format } from '@/lib/format';
import type { DailyPoint } from '@/lib/queries/orders';

// Vertical date markers rendered over the sparkline, used to show
// promo start/end dates so the team can visually correlate metric
// shifts with what's running.
export type SparklineMarker = { date: string; kind: 'start' | 'end'; label: string };

export function Sparkline({
  points,
  kind = 'count',
  className = '',
  width = 240,
  height = 48,
  markers,
  interactive = true,
  showPeak = interactive,
}: {
  points: DailyPoint[];
  // Used to format the hover tooltip's value identically to the card.
  kind?: Format;
  className?: string;
  width?: number;
  height?: number;
  markers?: SparklineMarker[];
  // Enables the hover tooltip + cursor guide. Disable for a fully
  // static line.
  interactive?: boolean;
  // Always-visible peak dot. Defaults to `interactive` but can be set
  // independently — e.g. the dense Layer 2 table rows want hover
  // tooltips (interactive) without a halo on every row (showPeak off).
  showPeak?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return <div className={`h-12 ${className}`} aria-hidden="true" />;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = innerW / (values.length - 1);
  const coords = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });
  const linePath = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  const [lastX, lastY] = coords[coords.length - 1];

  // First occurrence of the max value — the peak day. Marked with an
  // always-visible dot so the high point reads at a glance (and in a
  // screenshot) without hovering.
  const peakIdx = values.indexOf(max);
  const [peakX, peakY] = coords[peakIdx];

  // Map promo-date markers to x-positions by matching against the
  // sparkline's date axis. Markers for dates outside the window are
  // skipped silently.
  const markerLines = (markers ?? []).flatMap((m) => {
    const idx = points.findIndex((p) => p.date === m.date);
    if (idx < 0) return [];
    const x = pad + idx * stepX;
    return [{ x, kind: m.kind, label: m.label }];
  });

  // Translate cursor position to the nearest day index. preserveAspect-
  // Ratio="none" stretches the viewBox to the container width, so we map
  // off the container's pixel rect rather than viewBox units.
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    setHover(idx);
  };

  const active = interactive ? hover : null;
  const [hx, hy] = active !== null ? coords[active] : [0, 0];

  return (
    <div
      ref={wrapRef}
      className={`relative ${className}`}
      onMouseMove={interactive ? handleMove : undefined}
      onMouseLeave={interactive ? () => setHover(null) : undefined}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        aria-hidden="true"
      >
        <path d={areaPath} fill="currentColor" opacity="0.08" />
        {/* Promo markers — vertical amber dashed line. Render BEFORE the
            line path so the metric trend sits on top visually. */}
        {markerLines.map((m, i) => (
          <line
            key={`marker-${i}`}
            x1={m.x.toFixed(1)}
            x2={m.x.toFixed(1)}
            y1={pad}
            y2={height - pad}
            stroke={m.kind === 'start' ? '#f59e0b' : '#a8a29e'}
            strokeWidth="1"
            strokeDasharray="2,2"
            opacity="0.6"
          >
            <title>{m.label}</title>
          </line>
        ))}
        <path
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Always-visible peak dot (with a faint halo) so the high point
            stands out at rest. */}
        {showPeak && (
          <>
            <circle cx={peakX.toFixed(1)} cy={peakY.toFixed(1)} r="5" fill="currentColor" opacity="0.15" />
            <circle cx={peakX.toFixed(1)} cy={peakY.toFixed(1)} r="2.5" fill="currentColor" />
          </>
        )}
        {/* Latest-day dot. */}
        <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="2.5" fill="currentColor" opacity={showPeak ? 0.5 : 1} />
        {/* Hover guide line + dot. */}
        {active !== null && (
          <>
            <line
              x1={hx.toFixed(1)}
              x2={hx.toFixed(1)}
              y1={pad}
              y2={height - pad}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.35"
            />
            <circle cx={hx.toFixed(1)} cy={hy.toFixed(1)} r="3" fill="currentColor" />
          </>
        )}
      </svg>
      {/* Tooltip — anchored to the hovered day, centered over it. */}
      {active !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 py-1 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: `${(active / (points.length - 1)) * 100}%`, top: -2 }}
        >
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {fmtDayLabel(points[active].date)}
          </div>
          <div className="text-xs font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {fmt(points[active].value, kind)}
          </div>
        </div>
      )}
    </div>
  );
}

import { hexagonPoints } from "../../../../design-system/icon";

// The hero honeycomb from the design: navy cells, a few tint cells at the
// edges, and the honey hub joined by spokes to six honey nodes. Decorative.

type CellTone = "hive" | "tint" | "honey";

const RADIUS = 32.33;
const HUB = { x: 772, y: 113.3 };

/** Rows of the honeycomb: the row's centre line and its cells as [x, tone]. */
const ROWS: ReadonlyArray<{ y: number; cells: ReadonlyArray<[number, CellTone]> }> = [
  {
    y: 51,
    cells: [
      [592, "tint"],
      [664, "hive"],
      [736, "hive"],
      [808, "hive"],
      [880, "hive"],
      [952, "tint"],
    ],
  },
  {
    y: 113.3,
    cells: [
      [556, "hive"],
      [628, "hive"],
      [700, "hive"],
      [772, "honey"],
      [844, "hive"],
      [916, "hive"],
      [988, "hive"],
    ],
  },
  {
    y: 175.7,
    cells: [
      [520, "hive"],
      [592, "tint"],
      [664, "hive"],
      [736, "hive"],
      [808, "hive"],
      [880, "hive"],
      [952, "tint"],
    ],
  },
  {
    y: 238,
    cells: [
      [700, "tint"],
      [772, "hive"],
      [844, "hive"],
      [916, "tint"],
      [988, "hive"],
    ],
  },
];

/** The six cells around the hub, each with a honey node. */
const NODES: ReadonlyArray<[number, number]> = [
  [736, 51],
  [808, 51],
  [700, 113.3],
  [844, 113.3],
  [736, 175.7],
  [808, 175.7],
];

export function HeroIllustration() {
  return (
    <svg className="lp-honeycomb" viewBox="484 0 540 290" aria-hidden="true" focusable="false">
      <g className="lp-honeycomb-cells">
        {ROWS.flatMap(({ y, cells }) =>
          cells.map(([x, tone]) => (
            <polygon
              key={`${x},${y}`}
              points={hexagonPoints(x, y, RADIUS)}
              className={`lp-cell-${tone}`}
            />
          )),
        )}
      </g>
      <g className="lp-honeycomb-spokes">
        {NODES.map(([x, y]) => (
          <line key={`${x},${y}`} x1={HUB.x} y1={HUB.y} x2={x} y2={y} />
        ))}
      </g>
      {/* The buzz: each node pulses a honey glow, one after another. Stops
          under prefers-reduced-motion (landing.css). */}
      <g className="lp-honeycomb-pulses">
        {NODES.map(([x, y], index) => (
          <circle
            key={`${x},${y}`}
            cx={x}
            cy={y}
            r="9"
            style={{ animationDelay: `${index * 200}ms` }}
          />
        ))}
      </g>
      <g className="lp-honeycomb-nodes">
        {NODES.map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r="9" />
        ))}
      </g>
    </svg>
  );
}

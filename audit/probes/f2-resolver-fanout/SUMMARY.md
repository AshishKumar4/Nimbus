# F-2 Resolver Fan-Out — Layer Width + Wall-Time Profile

Captured: 2026-05-09T17:25:36.462Z
BASE: http://127.0.0.1:8792
Cohort size: 5 packages
Path: fanout (frontier-coordinator) ran on 5/5 packages
Total resolver-BFS layers observed: 27
Total resolver wall time: 24.00s

## Per-package

| Package | Path | Layers | Max width | p95 width | Avg width | Resolver wall (s) | npm install wall (s) |
|---------|------|--------|-----------|-----------|-----------|-------------------|----------------------|
| vite | fanout | 2 | 18 | 18 | 9.5 | n/a | 485.6 |
| webpack | fanout | 5 | 24 | 24 | 14 | 2.4 | 11.0 |
| drizzle-orm | fanout | 12 | 156 | 156 | 51.92 | 20.5 | 77.2 |
| express | fanout | 7 | 28 | 28 | 9.71 | 1 | 8.0 |
| zod | fanout | 1 | 1 | 1 | 1 | 0.1 | 6.0 |

## Aggregate

- Max width across cohort: 156
- p95 width: 134
- Median width: 12
- Mean width: 28.93

## Routing breakdown (NimbusFanoutPool auto-route)

- in-DO (POC C, width<5): 11 layers
- peer-DO (POC B, width≥5): 16 layers


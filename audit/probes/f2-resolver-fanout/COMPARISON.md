# F-2 Resolver Path Comparison: facet (baseline) vs fanout (F-2)

Captured: 2026-05-09T17:31:22.050Z

## Per-package resolver wall time (s)

| Package | facet (baseline) | fanout (F-2) | Speedup ×    | facet path verified | fanout path verified |
|---------|------------------|--------------|--------------|---------------------|----------------------|
| webpack | 2.6 | 1.1 | 2.36 | facet | fanout |
| drizzle-orm | 28.4 | 9 | 3.16 | facet | fanout |
| express | 1 | 0.8 | 1.25 | facet | fanout |
| zod | 0 | 0 | n/a | facet | fanout |

## Aggregate

- Average speedup (geometric-ish, simple mean): 2.26×

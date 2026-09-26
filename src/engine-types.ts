/**
 * engine-types.ts — the grading engine's shared, PURE primitive types.
 *
 * These used to live in store.ts (which imports React-Native AsyncStorage) and
 * tracker.ts. Pulling them here means the swing-analysis engine (pose-metrics,
 * swing-analysis, swing-report-stages, report-card-html) has ZERO React-Native
 * coupling — so the SAME engine can be imported by the web analyzer (`@engine/*`)
 * with no fork. store.ts / tracker.ts re-export these for back-compat.
 */
export type Sport = 'baseball' | 'softball';
export type Confidence = 'high' | 'medium' | 'low';

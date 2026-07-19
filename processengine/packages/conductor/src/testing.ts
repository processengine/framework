export { createMemoryStorage, createMemoryTransport, MemoryMessageTransport, MemoryProcessStorage } from './memory.js';
export { createMemoryConductor, ManualClock, runMessageTransportConformance, runProcessStorageConformance } from './conformance.js';
export type { MessageTransportConformanceOptions } from './conformance.js';

// Pure kernel state-transition helpers for simulating flow execution in tests
// without a live runtime. These are testing/simulation primitives, not part of
// the production runtime surface exposed from the package root.
export { evolve, success, failure } from './kernel.js';
export type { TransitionResult } from './types.js';

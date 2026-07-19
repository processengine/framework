export { createMemoryStorage, createMemoryTransport, MemoryMessageTransport, MemoryProcessStorage } from './memory.js';
export { createMemoryConductor, ManualClock, runMessageTransportConformance, runProcessStorageConformance } from './conformance.js';
export type { MessageTransportConformanceOptions } from './conformance.js';

// Pure kernel state-transition primitives for simulating flow execution in tests
// without a live runtime. These are testing/simulation only and are deliberately
// absent from the production package root.
export { evolve, success, failure } from './kernel.js';
export type { TransitionResult } from './types.js';

// Minimal Jest mock for hnswlib-wasm
class HierarchicalNSW {
  constructor() {}
  // Add stub methods as needed for your tests
  addPoint() {}
  searchKnn() { return { neighbors: [], distances: [] }; }
  writeIndex() {}
  readIndex() {}
  getCurrentCount() { return 0; }
}

module.exports = { HierarchicalNSW }; 
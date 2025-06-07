declare module 'hnswlib-wasm' {
  export class HierarchicalNSW {
    constructor(space: string, dim: number);
    addPoint(point: Float32Array, label: number): void;
    serialize(): Uint8Array;
    getCurrentCount(): number;
    // Add more as needed
  }
}

declare module 'hnswlib-wasm'; 
import { promises as fs } from 'fs';
import path from 'path';
import { MemvidConfig } from './config.js'; // Assuming this is now correctly defined
// ensureDir might be needed if not part of config.index.path handling
// import { ensureDir } from './utils'; // If direct fs operations are done for dir creation
import { HNSW } from 'hnsw';

const logger = {
  info: (message: string) => console.log(`[INFO][HNSWManager] ${message}`),
  warn: (message: string) => console.warn(`[WARN][HNSWManager] ${message}`),
  error: (message: string) => console.error(`[ERROR][HNSWManager] ${message}`),
};

export interface EmbeddingModel {
  embed(texts: string[]): Promise<number[][]>;
  // getDimension(): number; // Might be useful, or get from config
}

export interface ChunkMetadata {
  id: number; // Corresponds to the label in HNSW
  frame: number; // Frame number in video where QR code is stored
  length: number; // Length of the original text chunk (for reference)
  // Note: text is NOT stored here - it must be retrieved from QR code in video frame
}

export interface SearchResult {
  chunk_id: number;
  metadata: ChunkMetadata;
  distance: number; // HNSW returns distances
}

// Base IndexManager class for typing, can be removed if HNSWIndexManager is the only one
export abstract class IndexManager {
    constructor(protected config: MemvidConfig) {}
    abstract initIndex(): Promise<void>;
    abstract addChunks(chunks: string[], frames: number[]): Promise<number[]>;
    abstract search(query: string, topK: number): Promise<SearchResult[]>;
    abstract save(indexPath?: string): Promise<void>;
    abstract load(indexPath?: string): Promise<void>;
    abstract getChunkById(id: number): ChunkMetadata | null;
    abstract getStats(): Record<string, any>;
}


export class HNSWIndexManager extends IndexManager {
  private model: EmbeddingModel;
  private dimension: number;
  private maxElements: number;
  private index: any = null;
  private metadata: Map<number, ChunkMetadata> = new Map();
  private nextChunkId: number = 0; // Simple incrementing ID for chunks
  private hnswParams: { M?: number, efConstruction?: number, efSearch?: number };

  constructor(model: EmbeddingModel, config: MemvidConfig) {
    super(config);
    this.model = model;
    this.dimension = this.config.embedding.dimension;
    this.maxElements = this.config.index.maxElements || 10000;
    this.hnswParams = {
        M: this.config.index.M,
        efConstruction: this.config.index.efConstruction,
        efSearch: this.config.index.efSearch
    };
    // initIndex should be called explicitly after constructor
  }

  async initIndex(): Promise<void> {
    if (this.index) {
      logger.warn('Index already initialized.');
      return;
    }
    logger.info(`Initializing HNSW index with dimension ${this.dimension}, maxElements ${this.maxElements}`);
    // Use config.index.M and config.index.efConstruction if available, else defaults
    const M = this.hnswParams.M || 16;
    const efConstruction = this.hnswParams.efConstruction || 200;
    const metric = (this.config.index as any).metric || 'cosine';
    this.index = new HNSW(M, efConstruction, this.dimension, metric);
    logger.info('HNSW index initialized.');
  }

  private _ensureIndexInitialized(): void {
    if (!this.index) {
      throw new Error('HNSW Index not initialized. Call initIndex() first.');
    }
  }

  async addChunks(chunks: string[], frames: number[]): Promise<number[]> {
    this._ensureIndexInitialized();
    if (chunks.length === 0) return [];

    // Only log once for embedding
    if (chunks.length > 1) {
      logger.info(`Embedding ${chunks.length} chunks...`);
    }
    const embeddings = await this.model.embed(chunks);
    // Only log once for embedding complete
    if (chunks.length > 1) {
      logger.info(`Embedding complete. Adding ${embeddings.length} points to HNSW index.`);
    }

    const addedIds: number[] = [];
    for (let i = 0; i < embeddings.length; i++) {
      const embedding = embeddings[i];
      if (embedding.length !== this.dimension) {
        logger.error(`Embedding dimension mismatch for chunk ${i}. Expected ${this.dimension}, got ${embedding.length}. Skipping.`);
        continue;
      }

      const chunkId = this.nextChunkId++;
      // Convert embedding to Float32Array for hnsw
      const point = Float32Array.from(embedding);

      try {
        await this.index.addPoint(chunkId, point);
        // Store minimal metadata for lookup - text will be retrieved from QR code
        const meta: ChunkMetadata = {
          id: chunkId,
          frame: frames[i], // Frame number where QR code is stored
          length: chunks[i].length, // Original text length for reference
        };
        this.metadata.set(chunkId, meta);
        addedIds.push(chunkId);
        // Only log every 100th addition
        if ((i + 1) % 100 === 0) {
          logger.info(`Added ${i + 1} / ${embeddings.length} points to index...`);
        }
      } catch (error: any) {
        logger.error(`Failed to add point for chunkId ${chunkId}: ${error.message}`);
      }
    }
    // Summary log at the end
    logger.info(`Added ${addedIds.length} new points to index. Total items: ${this.index.nodes.size}`);
    return addedIds;
  }

  async search(query: string, topK: number): Promise<SearchResult[]> {
    this._ensureIndexInitialized();
    if (!query) return [];

    logger.info(`Embedding search query...`);
    const [queryEmbedding] = await this.model.embed([query]);
    if (!queryEmbedding || queryEmbedding.length !== this.dimension) {
        logger.error("Failed to embed query or dimension mismatch.");
        return [];
    }
    const queryPoint = Float32Array.from(queryEmbedding);

    logger.info(`Searching HNSW index for top ${topK} results...`);
    const result = this.index.searchKNN(queryPoint, topK);

    const searchResults: SearchResult[] = [];
    for (let i = 0; i < result.length; i++) {
      const { id: chunkId, score: distance } = result[i];
      const meta = this.metadata.get(chunkId);
      if (meta) {
        searchResults.push({ chunk_id: chunkId, metadata: meta, distance });
      } else {
        logger.warn(`Metadata not found for chunkId ${chunkId} in search results.`);
      }
    }
    logger.info(`Search found ${searchResults.length} results.`);
    return searchResults;
  }

  async save(basePath?: string): Promise<void> {
    this._ensureIndexInitialized();
    const savePath = basePath || this.config.index.path || 'memvid_index';
    const hnswFilePath = `${savePath}.hnsw.json`;
    const metaFilePath = `${savePath}.meta.json`;

    logger.info(`Saving HNSW index to ${hnswFilePath}`);
    const indexJson = this.index.toJSON();
    await fs.writeFile(hnswFilePath, JSON.stringify(indexJson));
    logger.info('HNSW index saved.');

    logger.info(`Saving metadata to ${metaFilePath}`);
    const serializableMetadata = Array.from(this.metadata.entries());
    await fs.writeFile(metaFilePath, JSON.stringify({ nextChunkId: this.nextChunkId, metadata: serializableMetadata }, null, 2));
    logger.info('Metadata saved.');
  }

  async serializeIndex(): Promise<Uint8Array> {
    this._ensureIndexInitialized();
    logger.info('Serializing HNSW index to buffer.');
    const json = JSON.stringify(this.index.toJSON());
    return new TextEncoder().encode(json);
  }

  async load(basePath?: string): Promise<void> {
    const loadPath = basePath || this.config.index.path || 'memvid_index';
    const hnswFilePath = `${loadPath}.hnsw.json`;
    const metaFilePath = `${loadPath}.meta.json`;

    logger.info(`Loading metadata from ${metaFilePath}...`);
    const metaFileContent = await fs.readFile(metaFilePath, 'utf-8');
    const { nextChunkId, metadata: serializableMetadata } = JSON.parse(metaFileContent);
    this.metadata = new Map(serializableMetadata);
    this.nextChunkId = nextChunkId;
    logger.info(`Metadata loaded. NextChunkId: ${this.nextChunkId}, Metadata items: ${this.metadata.size}`);

    logger.info(`Loading HNSW index from ${hnswFilePath}...`);
    const indexJson = JSON.parse(await fs.readFile(hnswFilePath, 'utf-8'));
    this.index = HNSW.fromJSON(indexJson);
    logger.info('HNSW index loaded.');
  }

  getChunkById(id: number): ChunkMetadata | null {
    return this.metadata.get(id) || null;
  }

  getStats(): Record<string, any> {
    return {
      dimension: this.dimension,
      maxElements: this.maxElements,
      currentCount: this.index ? this.index.size : 0,
      metadataCount: this.metadata.size,
      nextChunkId: this.nextChunkId,
    };
  }
}

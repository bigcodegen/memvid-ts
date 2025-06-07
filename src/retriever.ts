import { promises as fs } from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
// @ts-ignore
import ffprobePath from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';

// Updated import to HNSWIndexManager
import { HNSWIndexManager } from './indexManager.js';
import { SearchResult, ChunkMetadata } from './indexManager.js';
import { getDefaultConfig, MemvidConfig } from './config.js'; // Changed to getDefaultConfig
import {
  runFfmpegCommand,
  decodeQrImage,
  processQrText,
} from './utils.js';
import { TransformersEmbeddingModel } from './embeddingModel.js';

const logger = {
  info: (message: string) => console.log(`[INFO][RetrieverNative] ${message}`),
  warn: (message: string) => console.warn(`[WARN][RetrieverNative] ${message}`),
  error: (message: string) => console.error(`[ERROR][RetrieverNative] ${message}`),
};

interface FrameCache {
  [frameNumber: number]: string | null;
}

export class MemvidRetriever {
  private videoSource: string | Uint8Array;
  private config: MemvidConfig;
  // Changed type to HNSWIndexManager
  private indexManager: HNSWIndexManager;

  private _frameCache: FrameCache = {};
  private _cacheSize: number;

  private totalFrames: number = 0;
  private fps: number = 0;

  private videoBuffer: Uint8Array | null = null;
  private tempDir: string;

  public readyPromise: Promise<void>;

  constructor(videoSource: string | Uint8Array, indexFileOrBasePath: string, config?: Partial<MemvidConfig>) {
    this.videoSource = videoSource;
    const defaultConfig = getDefaultConfig(); // Changed to getDefaultConfig
    this.config = {
      ...defaultConfig,
      ...config,
      retrieval: {
        ...defaultConfig.retrieval,
        ...(config?.retrieval || {}),
      },
      embedding: { // Ensure embedding config is merged
        ...defaultConfig.embedding,
        ...(config?.embedding || {}),
      },
      index: { // Ensure index config is merged, and path is set from argument
        ...defaultConfig.index,
        ...(config?.index || {}),
        path: indexFileOrBasePath, // Use argument for the index path
      }
    };

    // Updated instantiation to HNSWIndexManager
    // Pass embedding model from config to TransformersEmbeddingModel constructor
    this.indexManager = new HNSWIndexManager(
        new TransformersEmbeddingModel(this.config.embedding.model),
        this.config
    );

    this._cacheSize = this.config.retrieval.cache_size;
    this.tempDir = path.join(this.config.tempDir || 'memvid_temp', `retriever_${Date.now()}`);
    // Pass the configured index base path to _initialize
    this.readyPromise = this._initialize(videoSource, this.config.index.path!);
  }

  private async _initialize(videoSource: string | Uint8Array, indexBasePath: string): Promise<void> {
    try {
      logger.info('Initializing native FFmpeg...');
      if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
      }
      if (ffprobePath) {
        ffmpeg.setFfprobePath(ffprobePath as unknown as string);
      }
      
      if (typeof videoSource === 'string') {
        logger.info(`Loading video from path: ${videoSource}`);
        this.videoBuffer = await fs.readFile(videoSource);
      } else {
        logger.info('Using provided video buffer.');
        this.videoBuffer = videoSource;
      }

      await fs.mkdir(this.tempDir, { recursive: true });
      await this._verifyVideo();

      logger.info(`Loading index from base path: ${indexBasePath}`);
      await this.indexManager.load(indexBasePath);

      logger.info('Retriever initialized successfully.');
    } catch (error: any) {
      logger.error(`Failed to initialize retriever: ${error.message}`);
      throw error;
    }
  }

  private async _verifyVideo(): Promise<void> {
    if (!this.videoBuffer) {
      throw new Error('Video buffer not initialized for _verifyVideo.');
    }
    
    // For now, use default values from config instead of trying to probe the video
    // This avoids the ffprobe path issues while still allowing the retriever to work
    this.fps = this.config.codecParameters[this.config.codec]?.videoFps || 30;
    
    // Estimate total frames based on video file size and typical frame size
    // This is a rough estimate but should work for our QR code videos
    const estimatedFrameSize = 20000; // Rough estimate for QR code frames
    this.totalFrames = Math.max(1, Math.floor(this.videoBuffer.length / estimatedFrameSize));
    
    logger.info(`Video verified (estimated): ${this.totalFrames} frames at ${this.fps.toFixed(2)} FPS`);
    logger.info(`Video buffer size: ${this.videoBuffer.length} bytes`);
  }

  private async _decodeSingleFrame(frameNumber: number): Promise<string | null> {
    await this.readyPromise;
    if (!this.videoBuffer) throw new Error("Retriever not initialized (video buffer missing).");
    if (this.fps === 0) throw new Error("FPS is 0, cannot decode frame. Ensure video was verified.");

    if (this._frameCache[frameNumber] !== undefined) {
      return this._frameCache[frameNumber];
    }

    const result = await this.extractFrameAndDecode(frameNumber);

    if (Object.keys(this._frameCache).length < this._cacheSize) {
      this._frameCache[frameNumber] = result;
    }
    return result;
  }

  private async _decodeFramesParallel(frameNumbers: number[]): Promise<FrameCache> {
    await this.readyPromise;
    if (!this.videoBuffer) throw new Error("Retriever not initialized.");
    if (this.fps === 0) throw new Error("FPS is 0, cannot decode frames.");

    const results: FrameCache = {};
    const framesToFetch: number[] = [];

    for (const frameNum of frameNumbers) {
      if (this._frameCache[frameNum] !== undefined) {
        results[frameNum] = this._frameCache[frameNum];
      } else {
        framesToFetch.push(frameNum);
      }
    }

    if (framesToFetch.length > 0) {
      // Process frames in parallel batches
      const batchSize = this.config.retrieval.max_workers || 4;
      for (let i = 0; i < framesToFetch.length; i += batchSize) {
        const batch = framesToFetch.slice(i, i + batchSize);
        const batchPromises = batch.map(async (frameNum) => {
          const data = await this.extractFrameAndDecode(frameNum);
          return { frameNum, data };
        });
        
        const batchResults = await Promise.all(batchPromises);
        for (const { frameNum, data } of batchResults) {
          results[frameNum] = data;
          if (Object.keys(this._frameCache).length < this._cacheSize) {
            this._frameCache[frameNum] = data;
          }
        }
      }
    }
    return results;
  }

  async search(query: string, top_k: number = 5): Promise<string[]> {
    await this.readyPromise;
    // HNSWIndexManager search returns SearchResult[]
    const searchResults: SearchResult[] = await this.indexManager.search(query, top_k);
    const frameNumbers = Array.from(new Set(searchResults.map(result => result.metadata.frame)));
    const texts: string[] = [];
    for (const searchResult of searchResults) {
      const { metadata } = searchResult;
      const frameNum = metadata.frame;
      const decodedText = await this._decodeSingleFrame(frameNum);
      if (decodedText) {
        try {
          const chunkData = JSON.parse(decodedText);
          texts.push(chunkData.text);
        } catch (e) {
          logger.warn(`Failed to parse JSON from decoded frame ${frameNum}. Content: "${decodedText.substring(0,50)}..." Error: ${e}`);
          texts.push(`[Frame ${frameNum} decode error]`);
        }
      } else {
        logger.warn(`Failed to decode QR from frame ${frameNum}`);
        texts.push(`[Frame ${frameNum} not readable]`);
      }
    }
    logger.info(`Native Search completed for query: '${query.substring(0, 50)}...'`);
    return texts;
  }

  async getChunkById(chunkId: number): Promise<string | null> {
    await this.readyPromise;
    const metadata = this.indexManager.getChunkById(chunkId);
    if (metadata) {
      const frameNum = metadata.frame;
      const decoded = await this._decodeSingleFrame(frameNum);
      if (decoded) {
        try {
          const chunkData = JSON.parse(decoded);
          return chunkData.text;
        } catch (e) {
          logger.warn(`Failed to parse JSON from decoded frame ${frameNum} for chunk ${chunkId}. Content: "${decoded.substring(0,50)}..." Error: ${e}`);
          return `[Frame ${frameNum} decode error]`;
        }
      }
      logger.warn(`Failed to decode QR from frame ${frameNum} for chunk ${chunkId}`);
      return `[Frame ${frameNum} not readable]`;
    }
    return null;
  }

  async searchWithMetadata(query: string, top_k: number = 5): Promise<Array<Record<string, any>>> {
    await this.readyPromise;
    const startTime = Date.now();
    const searchResults: SearchResult[] = await this.indexManager.search(query, top_k);
    const frameNumbers = Array.from(new Set(searchResults.map(result => result.metadata.frame)));
    const decodedFrames = await this._decodeFramesParallel(frameNumbers);

    const results: Array<Record<string, any>> = [];
    for (const searchResult of searchResults) {
      // HNSW returns distance, SearchResult interface matches this
      const { chunk_id, distance, metadata } = searchResult;
      const frameNum = metadata.frame;
      let text: string;
      const decodedText = decodedFrames[frameNum];

      if (decodedText) {
        try {
          const chunkData = JSON.parse(decodedText);
          text = chunkData.text;
        } catch (e) {
          text = `[Frame ${frameNum} decode error]`;
          logger.warn(`Failed to parse JSON from decoded frame ${frameNum} for searchWithMetadata. Content: "${decodedText.substring(0,50)}..." Error: ${e}`);
        }
      } else {
        text = `[Frame ${frameNum} not readable]`;
      }

      results.push({
        text: text,
        score: 1.0 / (1.0 + distance),
        chunk_id: chunk_id,
        frame: frameNum,
        metadata: metadata
      });
    }
    const elapsed = (Date.now() - startTime) / 1000;
    logger.info(`Native Search with metadata completed in ${elapsed.toFixed(3)}s`);
    return results;
  }

  async getContextWindow(chunkId: number, windowSize: number = 2): Promise<string[]> {
    await this.readyPromise;
    const chunks: string[] = [];
    for (let offset = -windowSize; offset <= windowSize; offset++) {
      const targetId = chunkId + offset;
      const chunk = await this.getChunkById(targetId);
      if (chunk) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  async prefetchFrames(frameNumbers: number[]): Promise<void> {
    await this.readyPromise;
    const toPrefetch = frameNumbers.filter(f => this._frameCache[f] === undefined);
    if (toPrefetch.length > 0) {
      logger.info(`Prefetching ${toPrefetch.length} frames (Native)...`);
      const decoded = await this._decodeFramesParallel(toPrefetch);
      const prefetchedCount = Object.values(decoded).filter(d => d !== null).length;
      logger.info(`Successfully prefetched and decoded ${prefetchedCount} frames out of ${toPrefetch.length} requested.`);
    }
  }

  clearCache(): void {
    this._frameCache = {};
    logger.info("Cleared retriever's frame cache.");
  }

  async cleanup(): Promise<void> {
    try {
      await fs.rmdir(this.tempDir, { recursive: true });
      logger.info(`Cleaned up temp directory: ${this.tempDir}`);
    } catch (error: any) {
      logger.warn(`Failed to cleanup temp directory: ${error.message}`);
    }
  }

  async getStats(): Promise<Record<string, any>> {
    await this.readyPromise;
    return {
      video_source_type: typeof this.videoSource === 'string' ? 'path' : 'buffer',
      total_frames: this.totalFrames,
      fps: this.fps,
      cache_size: Object.keys(this._frameCache).length,
      max_cache_size: this._cacheSize,
      index_stats: this.indexManager.getStats(),
      is_ready: this.videoBuffer !== null && this.indexManager !== null,
    };
  }

  private async extractFrameAndDecode(frameNumber: number): Promise<string | null> {
    if (!this.videoBuffer) throw new Error('Video buffer not loaded');
    const frameDir = path.join(this.tempDir, `frame_${frameNumber}_${Date.now()}`);
    await fs.mkdir(frameDir, { recursive: true });
    const tempVideoPath = path.join(frameDir, 'input.mp4');
    const framePath = path.join(frameDir, `frame_${frameNumber}.png`);
    
    try {
      await fs.writeFile(tempVideoPath, this.videoBuffer);
      // Extract the frame using ffmpeg
      // Calculate time position based on frame number and fps
      const timePosition = frameNumber / this.fps;
      await runFfmpegCommand(
        tempVideoPath,
        framePath,
        [
          '-ss', timePosition.toString(),
          '-vframes', '1',
          '-f', 'image2',
        ]
      );
      // Read and decode the QR code from the PNG
      const frameBuffer = await fs.readFile(framePath);
      const rawQrText = await decodeQrImage(frameBuffer);
      if (!rawQrText) return null;
      
      // Process the QR text (handle compression, etc.)
      const processedText = processQrText(rawQrText);
      return processedText;
    } catch (error: any) {
      logger.error(`Error extracting/decoding frame ${frameNumber}: ${error.message}`);
      return null;
    } finally {
      // Cleanup
      try { await fs.unlink(tempVideoPath); } catch(e) {/* ignore */}
      try { await fs.unlink(framePath); } catch(e) {/* ignore */}
      try { await fs.rmdir(frameDir); } catch(e) {/* ignore */}
    }
  }
}

import { promises as fs } from 'fs'; // Keep for reading PDF/EPUB from path in Node.js
import path from 'path';
import { getDefaultConfig, MemvidConfig, QrConfig, getCodecParameters, CodecConfig } from './config.js';
import { chunkText, generateQrBuffer, runFfmpegCommand } from './utils.js';
import { HNSWIndexManager } from './indexManager.js';
import { TransformersEmbeddingModel } from './embeddingModel.js';

const logger = {
  info: (message: string) => console.log(`[INFO][EncoderNative] ${message}`),
  warn: (message: string) => console.warn(`[WARN][EncoderNative] ${message}`),
  error: (message: string) => console.error(`[ERROR][EncoderNative] ${message}`),
};

export class MemvidEncoder {
  private chunks: string[] = [];
  private config: MemvidConfig;
  private index: HNSWIndexManager;

  constructor(config?: Partial<MemvidConfig>) {
    const defaultConfig = getDefaultConfig();
    this.config = {
        ...defaultConfig,
        ...config,
        embedding: { ...defaultConfig.embedding, ...(config?.embedding || {}) },
        index: { ...defaultConfig.index, ...(config?.index || {}) },
        qr: { ...defaultConfig.qr, ...(config?.qr || {}) },
        codecParameters: { ...defaultConfig.codecParameters, ...(config?.codecParameters || {})},
    };
    this.index = new HNSWIndexManager(
        new TransformersEmbeddingModel(this.config.embedding.model),
        this.config
    );
  }

  addText(text: string): void {
    const { chunkSize, overlap } = this.config;
    if (!text || text.trim() === "") {
        logger.warn("Attempted to add empty text. Skipping.");
        return;
    }
    const newChunks = chunkText(text, chunkSize, overlap);
    this.chunks.push(...newChunks);
    logger.info(`Added ${newChunks.length} new chunks. Total chunks: ${this.chunks.length}`);
  }

  async addPdf(pdfSource: string | Uint8Array | ArrayBuffer): Promise<void> {
    // Lazy import for Node compatibility
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.js');
    const pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.entry.js');
    logger.info(`Starting PDF processing.`);
    let pdfData: ArrayBuffer;
    if (typeof pdfSource === 'string') {
      pdfData = await fs.readFile(pdfSource);
    } else if (pdfSource instanceof Uint8Array) {
      pdfData = pdfSource.buffer;
    } else {
      pdfData = pdfSource;
    }
    if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
    }
    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      fullText += textContent.items.map((item: any) => (item as any).str).join(' ') + "\n\n";
    }
    this.addText(fullText.trim());
  }

  async addEpub(epubSource: string | ArrayBuffer): Promise<void> {
    // Lazy import for Node compatibility
    const ePub = (await import('epub.js')).default;
    logger.info(`Starting EPUB processing.`);
    let bookData: ArrayBuffer | string;
    if (typeof epubSource === 'string') {
        bookData = await fs.readFile(epubSource);
    } else {
        bookData = epubSource;
    }
    const book = ePub(bookData);
    await book.opened;
    let fullText = "";
    for (const section of book.spine.items) {
        if (section.href) {
            try {
                const loadedSection = await section.load(book.load.bind(book));
                if (loadedSection && (loadedSection as any).body && (loadedSection as any).body.textContent) {
                    fullText += ((loadedSection as any).body.textContent || "").trim() + "\n\n";
                } else { // Fallback for sections that might not load as full Document
                    const blob = await section.output("blob");
                    if (blob) {
                        const htmlContent = await new Response(blob).text();
                        const tempDiv = document.createElement('div'); // Browser-specific
                        tempDiv.innerHTML = htmlContent;
                        fullText += (tempDiv.textContent || "").trim() + "\n\n";
                    }
                }
            } catch (err) {
                logger.error(`Error loading or parsing EPUB section ${section.href}: ${err}`);
            }
        }
    }
    this.addText(fullText.trim());
  }

  async buildVideo(outputFileNameSuggestion?: string): Promise<{
    videoBuffer: Uint8Array,
    indexDataBuffer?: Uint8Array,
    stats: { frameCount: number, videoGenTimeMs: number, indexBuildTimeMs: number }
  }> {
    const videoStartTime = Date.now();
    if (this.chunks.length === 0) {
      logger.warn("No text chunks to encode. Video and index will be empty or not generated.");
      await this.index.initIndex();
      const emptyIndexBuffer = await this.index.serializeIndex();
      return {
        videoBuffer: new Uint8Array(),
        indexDataBuffer: emptyIndexBuffer,
        stats: { frameCount: 0, videoGenTimeMs: Date.now() - videoStartTime, indexBuildTimeMs: 0 }
      };
    }

    // 1. Write QR code frames to temp directory
    const tempDir = path.join(this.config.tempDir || 'memvid_temp', `frames_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await this.index.initIndex();
    const frameFileNames: string[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const frameForChunk = i;
      const chunkPayload = JSON.stringify({ text: chunk, frame: frameForChunk });
      const qrBuffer = await generateQrBuffer(chunkPayload, this.config.qr || {});
      if (qrBuffer) {
        const frameName = `frame_${frameForChunk.toString().padStart(6, '0')}.png`;
        const framePath = path.join(tempDir, frameName);
        await fs.writeFile(framePath, qrBuffer);
        frameFileNames.push(framePath);
        await this.index.addChunks([chunk], [frameForChunk]);
        if (i % 100 === 0) {
          logger.info(`Generated frame ${i + 1} / ${this.chunks.length}`);
        }
      } else {
        logger.warn(`Skipping frame ${frameForChunk} due to QR generation failure.`);
      }
    }
    logger.info(`Generated ${frameFileNames.length} QR code frames in temp dir: ${tempDir}`);

    // 2. Encode video using ffmpeg-static + fluent-ffmpeg
    const codecConfig = getCodecParameters(this.config, this.config.codec) || getCodecParameters(this.config, "h264Wasm");
    if (!codecConfig) throw new Error("Valid codec configuration not found.");
    const outputFile = outputFileNameSuggestion || `output.${codecConfig.videoFileType}`;
    const ffmpegArgs: string[] = [
      '-framerate', codecConfig.videoFps.toString(),
      '-c:v', codecConfig.codecNameInternal,
      '-s', `${codecConfig.frameWidth}x${codecConfig.frameHeight}`,
      '-pix_fmt', codecConfig.pixFmt,
    ];
    if (codecConfig.videoBitrate) {
      ffmpegArgs.push('-b:v', codecConfig.videoBitrate);
    } else if (codecConfig.videoCrf !== undefined) {
      ffmpegArgs.push('-crf', codecConfig.videoCrf.toString());
    }
    if (codecConfig.extraFfmpegArgs) {
      ffmpegArgs.push(...codecConfig.extraFfmpegArgs);
    }
    // Input pattern for ffmpeg
    const inputPattern = path.join(tempDir, 'frame_%06d.png');
    ffmpegArgs.unshift('-i', inputPattern);
    logger.info(`Running FFmpeg command with args: ${ffmpegArgs.join(' ')}`);
    await runFfmpegCommand(inputPattern, outputFile, ffmpegArgs);
    logger.info(`FFmpeg processing finished. Reading video output: ${outputFile}`);
    const videoData = await fs.readFile(outputFile);
    const videoGenTimeMs = Date.now() - videoStartTime;

    // 3. Index Building
    const indexStartTime = Date.now();
    const frameNumbers = Array.from({ length: this.chunks.length }, (_, i) => i);
    await this.index.addChunks(this.chunks, frameNumbers);
    
    // Save the index using the proper save method that creates both .hnsw.json and .meta.json
    if (this.config.index.path) {
      await this.index.save(this.config.index.path);
      logger.info(`Index saved to ${this.config.index.path}`);
    }
    
    // Also serialize for backward compatibility
    const indexDataBuffer = await this.index.serializeIndex();
    logger.info("HNSW index built and serialized.");
    const indexBuildTimeMs = Date.now() - indexStartTime;

    // 4. Cleanup temp files
    for (const framePath of frameFileNames) {
      try { await fs.unlink(framePath); } catch(e) {/* ignore */}
    }
    try { await fs.rmdir(tempDir); } catch(e) {/* ignore */}
    logger.info("Cleaned up temp frame files.");

    this.chunks = [];

    return {
      videoBuffer: videoData,
      indexDataBuffer,
      stats: {
        frameCount: frameFileNames.length,
        videoGenTimeMs: videoGenTimeMs,
        indexBuildTimeMs: indexBuildTimeMs,
      }
    };
  }
}
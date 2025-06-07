import { BrowserQRCodeReader, NotFoundException } from '@zxing/library';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import { promises as fs } from 'fs';
import path from 'path';
import qrcode from 'qrcode';
import pako from 'pako';
import { QrConfig } from './config.js';
import { pathToFileURL } from 'url';
import fsSync from 'fs';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';

const logger = {
  info: (message: string) => console.log(`[INFO][UtilsWASM] ${message}`),
  warn: (message: string) => console.warn(`[WARN][UtilsWASM] ${message}`),
  error: (message: string) => console.error(`[ERROR][UtilsWASM] ${message}`),
  debug: (message: string) => console.debug(`[DEBUG][UtilsWASM] ${message}`), // Added debug level
};

// @ts-ignore
const qrCache = new LRUCache<string, string | null>({ max: 100 });

let ffmpegInstance: any = null;
let ffmpegLoadingPromise: Promise<any> | null = null;

export async function loadFFmpeg(): Promise<any> {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (ffmpegLoadingPromise) return ffmpegLoadingPromise;

  ffmpegLoadingPromise = (async () => {
    try {
      const ffmpegModule = await import('@ffmpeg/ffmpeg');
      const { createFFmpeg } = ffmpegModule;
      // Custom fetch for Node.js to load ffmpeg-core.wasm as a buffer
      const customFetch = async (url: string, options?: any) => {
        if (url.endsWith('ffmpeg-core.wasm')) {
          const wasmPath = path.resolve(
            __dirname,
            '../../node_modules/@ffmpeg/core/dist/ffmpeg-core.wasm'
          );
          const buffer = await fsSync.promises.readFile(wasmPath);
          return new Response(buffer);
        } else {
          // Fallback to default fetch
          return fetch(url, options);
        }
      };
      const instance = createFFmpeg({ log: true, fetch: customFetch });
      logger.info('Loading FFmpeg core...');
      await (instance as any).load();
      logger.info('FFmpeg core loaded successfully.');
      ffmpegInstance = instance;
      return instance;
    } catch (error: any) {
      logger.error(`Failed to load FFmpeg core: ${error.message || error}`);
      if (error.stack) logger.debug(`FFmpeg load error stack: ${error.stack}`);
      ffmpegLoadingPromise = null;
      throw error;
    }
  })();
  return ffmpegLoadingPromise;
}

export async function extractFrameWASM(
  ffmpeg: any,
  videoBuffer: Uint8Array,
  frameNumber: number,
  outputFrameName: string = `frame_${frameNumber}.png`, // Default name includes frameNumber
  fps: number
): Promise<Uint8Array | null> {
  // @ts-ignore
  if (!ffmpeg.loaded) {
    logger.error('FFmpeg is not loaded for extractFrameWASM.');
    throw new Error('FFmpeg is not loaded.');
  }
  const inputFileName = `input_${Date.now()}.mp4`;
  logger.info(`Attempting to extract frame ${frameNumber} as ${outputFrameName} from video.`);
  try {
    ffmpeg.FS('writeFile', inputFileName, videoBuffer);
    if (fps <= 0) {
        logger.error(`Invalid FPS: ${fps} for frame extraction.`);
        throw new Error("FPS must be positive for frame extraction.");
    }
    await ffmpeg.run('-i', inputFileName, '-vf', `select='eq(n,${frameNumber})'`, '-vframes', '1', outputFrameName);

    try {
      const data = ffmpeg.FS('readFile', outputFrameName);
      logger.info(`Successfully extracted frame ${frameNumber} to ${outputFrameName}.`);
      return new Uint8Array(data.buffer);
    } catch (readError: any) {
      logger.error(`Failed to read extracted frame ${outputFrameName} from MEMFS for frame ${frameNumber}: ${readError.message || readError}`);
      return null;
    }
  } catch (error: any) {
    logger.error(`Error during ffmpeg.run for frame ${frameNumber} (output ${outputFrameName}): ${error.message || error}`);
    if(error.stack) logger.debug(`ffmpeg.run error stack: ${error.stack}`);
    return null;
  } finally {
    try { ffmpeg.FS('unlink', inputFileName); } catch (e) { /* ignore cleanup error */ }
    try { ffmpeg.FS('unlink', outputFrameName); } catch (e) { /* ignore cleanup error */ }
  }
}

// Node.js-compatible QR code decoding using qrcode-reader and jimp
export async function decodeQrImage(imageBuffer: Uint8Array): Promise<string | null> {
  try {
    // Dynamic imports to avoid issues
    // @ts-ignore
    const QrCode = (await import('qrcode-reader')).default;
    const Jimp = await import('jimp');
    
    // Load image with Jimp
    // @ts-ignore
    const image = await Jimp.Jimp.read(Buffer.from(imageBuffer));
    
    // Create QR code reader
    const qr = new QrCode();
    
    return new Promise((resolve) => {
      qr.callback = (err: any, value: any) => {
        if (err) {
          logger.warn(`QR decoding failed: ${err.message || err}`);
          resolve(null);
        } else {
          resolve(value.result);
        }
      };
      
      // Decode the QR code
      qr.decode(image.bitmap);
    });
    
  } catch (error: any) {
    logger.error(`Error in QR decoding setup: ${error.message || error}`);
    return null;
  }
}

// Renamed from decodeQrData
export function processQrText(qrText: string): string {
  if (qrText.startsWith("GZ:")) {
    try {
      const base64Data = qrText.substring(3);
      const compressed = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const decompressed = pako.ungzip(compressed, { to: 'string' });
      logger.info("Successfully decompressed GZipped QR data.");
      return decompressed;
    } catch (error: any) {
      logger.error(`Failed to decompress GZipped QR data: ${error.message || error}. Returning raw data.`);
      return qrText;
    }
  }
  return qrText;
}

export function clearQrCacheWASM(): void {
  qrCache.clear();
  logger.info("WASM QR Decode Cache cleared.");
}

export async function extractAndDecodeCachedWASM(
  videoBuffer: Uint8Array,
  frameNumber: number,
  fps: number
): Promise<string | null> {
  const cacheKey = `wasm_video_frame_processed_${frameNumber}`;
  if (qrCache.has(cacheKey)) {
    logger.debug(`Cache hit for processed frame ${frameNumber}`);
    return qrCache.get(cacheKey) as string | null;
  }

  let ffmpegLoc: any; // Renamed to avoid conflict with global
  try {
    ffmpegLoc = await loadFFmpeg();
  } catch (error) { // Error already logged by loadFFmpeg
    return null; // Failed to load FFmpeg, cannot proceed
  }

  const frameImageBuffer = await extractFrameWASM(ffmpegLoc, videoBuffer, frameNumber, `frame_tocache_${frameNumber}.png`, fps);
  if (!frameImageBuffer) {
    logger.warn(`Frame extraction failed for frame ${frameNumber} in extractAndDecodeCachedWASM.`);
    qrCache.set(cacheKey, null);
    return null;
  }

  const rawQrText = await decodeQrImage(frameImageBuffer);
  if (!rawQrText) {
    logger.warn(`QR image decoding failed for frame ${frameNumber} in extractAndDecodeCachedWASM.`);
    qrCache.set(cacheKey, null);
    return null;
  }

  const finalData = processQrText(rawQrText);
  qrCache.set(cacheKey, finalData);
  return finalData;
}

export async function batchExtractAndDecodeWASM(
  videoBuffer: Uint8Array,
  frameNumbers: number[],
  fps: number,
  maxWorkers: number = 1
): Promise<Record<number, string | null>> {
  const limit = pLimit(maxWorkers);
  const results: Record<number, string | null> = {};
  const tasks = frameNumbers.map(frameNumber =>
    limit(async () => {
      results[frameNumber] = await extractAndDecodeCachedWASM(videoBuffer, frameNumber, fps);
    })
  );
  await Promise.all(tasks);
  logger.info(`WASM batch processing completed for ${frameNumbers.length} frames.`);
  return results;
}

export async function generateQrBuffer(data: string, qrConfig?: QrConfig): Promise<Uint8Array | null> {
  let processedData = data;
  if (data.length > 100) {
    try {
      const compressed = pako.gzip(data);
      let base64String = '';
      for (let i = 0; i < compressed.length; i++) {
        base64String += String.fromCharCode(compressed[i]);
      }
      processedData = "GZ:" + btoa(base64String);
      logger.info(`Original data length ${data.length}, compressed+base64 for QR: ${processedData.length}`);
    } catch (error: any) {
      logger.error(`Failed to gzip data for QR code: ${error.message || error}. Using original data.`);
      processedData = data;
    }
  }

  try {
    const options: qrcode.QRCodeToBufferOptions = {
      type: 'png',
      version: qrConfig?.version,
      errorCorrectionLevel: qrConfig?.errorCorrectionLevel || 'M',
      margin: qrConfig?.border,
      scale: qrConfig?.boxSize,
      color: {
        dark: qrConfig?.fillColor || '#000000',
        light: qrConfig?.backColor || '#FFFFFF',
      },
    };
    Object.keys(options).forEach(key => options[key as keyof qrcode.QRCodeToBufferOptions] === undefined && delete options[key as keyof qrcode.QRCodeToBufferOptions]);
    if (options.color && options.color.dark === undefined) delete options.color.dark;
    if (options.color && options.color.light === undefined) delete options.color.light;

    const buffer = await qrcode.toBuffer(processedData, options);
    return new Uint8Array(buffer);
  } catch (error: any) {
    logger.error(`Failed to generate QR code buffer: ${error.message || error}`);
    return null;
  }
}

// --- Text Chunking ---
export function simpleChunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  if (!text || size <= 0) return chunks;
  if (overlap >= size) overlap = size / 2; // Ensure overlap is less than size

  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + size, text.length);
    chunks.push(text.slice(i, end));
    i += (size - overlap);
    if (i >= end && end < text.length) { // Ensure progress if overlap is large or size is small
        i = end; // Move to the end of the last chunk to avoid re-processing same small segment
    }
  }
  return chunks.filter(chunk => chunk.length > 0);
}

export function chunkText(text: string, chunkSize: number, overlap: number, language: string = 'en'): string[] {
  if (!text || text.trim() === "") return [];
  if (chunkSize <= 0) {
    logger.warn("chunkSize must be positive. Returning empty array.");
    return [];
  }
  if (overlap < 0) overlap = 0;
  if (overlap >= chunkSize) {
    logger.warn(`Overlap (${overlap}) is too large for chunkSize (${chunkSize}). Setting overlap to half of chunkSize.`);
    overlap = Math.floor(chunkSize / 2);
  }

  const chunks: string[] = [];
  // Sentence endings regex: accounts for periods, question marks, exclamation marks, followed by space or newline.
  // Also splits on double newlines (paragraph breaks).
  const sentenceEndings = /(?<=[.?!])\s+|\n\n+|\r\n\r\n+/;
  const sentences = text.split(sentenceEndings).filter(s => s && s.trim().length > 0);

  if (sentences.length === 0) { // No clear sentence breaks, or very short text
    return simpleChunkText(text, chunkSize, overlap);
  }

  let currentChunk = "";
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    if (sentence.length === 0) continue;

    // If a single sentence is too long, split it with simpleChunkText
    if (sentence.length > chunkSize) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = ""; // Reset current chunk
      }
      // Add sub-chunks of the long sentence
      const subChunks = simpleChunkText(sentence, chunkSize, overlap);
      chunks.push(...subChunks.filter(sc => sc.length > 0));
      currentChunk = ""; // Ensure next chunk starts fresh after splitting a long sentence
      continue; // Move to the next sentence
    }

    // Check if adding the next sentence exceeds chunkSize
    const potentialNextLength = currentChunk.length + (currentChunk.length > 0 ? 1 : 0) + sentence.length;
    if (potentialNextLength > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());

      // Overlap handling: start new chunk with some content from the end of the previous one.
      // A simple way: start the new chunk with the sentence that caused the overflow if overlap is tricky.
      // Or, more complex: try to find a point 'overlap' characters back.
      // Current simple approach: the sentence that overflowed becomes the start of the new chunk.
      currentChunk = sentence;
      // For a character-based overlap (more complex to implement with sentences):
      // const lastChunkText = chunks[chunks.length - 1];
      // const overlapStartIndex = Math.max(0, lastChunkText.length - overlap);
      // currentChunk = lastChunkText.substring(overlapStartIndex) + " " + sentence;
      // This would need adjustment to avoid re-adding full sentences.
      // For now, sentence-based overlap is implicit by how sentences are added.
      // A more explicit character overlap on sentence-chunked text would be:
      if (chunks.length > 0 && overlap > 0) {
          const prevChunk = chunks[chunks.length-1];
          let overlapText = "";
          // Find suitable overlap point from original text based on prevChunk's end
          // This is non-trivial. For now, let's use a simpler sentence-based overlap.
          // The current logic will just start the new chunk with the overflowing sentence.
          // To implement a character-based overlap more directly with sentence chunking:
          // One might need to track original text indices or reconstruct.
          // For now, the "overlap" param is more like a hint for simpleChunkText fallback.
      }


    } else {
      if (currentChunk.length > 0) {
        currentChunk += " "; // Add space between sentences
      }
      currentChunk += sentence;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}


// --- Preserved utility functions (ensureDir, framePath) ---
export async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export function framePath(dir: string, index: number): string {
  return path.join(dir, `frame_${index.toString().padStart(6, '0')}.png`);
}

export function runFfmpegCommand(inputPath: string, outputPath: string, ffmpegArgs: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
    let command = ffmpeg(inputPath).output(outputPath);
    if (ffmpegArgs.length > 0) {
      command = command.addOutputOptions(ffmpegArgs);
    }
    command
      .on('end', () => {
        logger.info(`FFmpeg processing finished: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        logger.error(`FFmpeg error: ${err}`);
        reject(err);
      })
      .run();
  });
}

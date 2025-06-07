import { chunkText, generateQrBuffer } from '../src/utils';
// import { MemvidRetriever } from '../src/retriever'; // Not used in native mode
import { getDefaultConfig } from '../src/config';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import faiss from 'faiss-node';
const Jimp = require('jimp').Jimp;
const QrCode = require('qrcode-reader');

const TEST_VIDEO = 'test_e2e_output.mp4';
const TEST_INDEX = 'test_e2e_index';
const TEST_FRAMES_DIR = 'test_e2e_frames';
const TEST_EXTRACTED_FRAMES_DIR = 'test_e2e_extracted_frames';

const SAMPLE_TEXT = `The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow.`;

async function cleanup() {
  for (const ext of ['.mp4', '.faiss', '.meta.json']) {
    try { await fs.unlink(TEST_INDEX + ext); } catch {}
  }
  try { await fs.unlink(TEST_VIDEO); } catch {}
  try { await fs.rm(TEST_FRAMES_DIR, { recursive: true, force: true }); } catch {}
  try { await fs.rm(TEST_EXTRACTED_FRAMES_DIR, { recursive: true, force: true }); } catch {}
}

// Minimal Faiss-based index manager for E2E
class FaissIndexManager {
  private dim: number;
  private index: any;
  private texts: string[] = [];
  constructor(dim: number) {
    this.dim = dim;
    this.index = new faiss.IndexFlatL2(dim);
  }
  async addChunks(embeddings: number[][], texts: string[]) {
    console.log('Adding to Faiss:', embeddings.length, embeddings[0]?.length);
    // Check for NaN/undefined/null and convert to plain arrays
    const cleanEmbeddings = embeddings.map((e, i) => {
      if (!Array.isArray(e)) throw new Error(`Embedding at ${i} is not an array`);
      for (let j = 0; j < e.length; j++) {
        if (typeof e[j] !== 'number' || isNaN(e[j]) || e[j] == null) {
          throw new Error(`Invalid value at embedding[${i}][${j}]: ${e[j]}`);
        }
      }
      return Array.from(e);
    });
    for (const e of cleanEmbeddings) {
      this.index.add(e);
    }
    this.texts.push(...texts);
  }
  async search(queryEmbedding: number[], topK: number): Promise<string[]> {
    const query = Array.from(queryEmbedding);
    const { distances, labels } = this.index.search(query, topK);
    return Array.from(labels as number[]).map(idx => this.texts[idx]);
  }
}

// Native retriever: uses Faiss for vector search
class MemvidRetrieverNative {
  private index: FaissIndexManager;
  private embedder: any;
  private config: any;
  constructor(index: FaissIndexManager, embedder: any, config: any) {
    this.index = index;
    this.embedder = embedder;
    this.config = config;
  }
  async search(query: string, top_k: number = 5): Promise<string[]> {
    const [queryEmbedding] = await this.embedder.embed([query]);
    return await this.index.search(queryEmbedding, top_k);
  }
}

async function extractFramesFromVideo(videoPath: string, outputDir: string, fps: number): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-vf', `fps=${fps}`
      ])
      .output(path.join(outputDir, 'frame_%06d.png'))
      .on('end', async () => {
        const files = (await fs.readdir(outputDir)).filter(f => f.endsWith('.png')).map(f => path.join(outputDir, f));
        resolve(files.sort());
      })
      .on('error', reject)
      .setFfmpegPath(ffmpegStatic as string)
      .run();
  });
}

async function decodeQrFromPng(pngPath: string): Promise<string | null> {
  const image = await Jimp.read(pngPath);
  return new Promise((resolve) => {
    const qr = new QrCode();
    qr.callback = (err: any, value: any) => {
      if (err || !value) return resolve(null);
      resolve(value.result);
    };
    qr.decode(image.bitmap);
  });
}

(async () => {
  await cleanup();
  const config = getDefaultConfig();
  config.index.path = TEST_INDEX;
  config.chunkSize = 40;
  config.overlap = 0;
  config.embedding.model = 'Xenova/all-MiniLM-L6-v2';
  config.embedding.dimension = 384;
  config.codec = 'h264Wasm';
  config.codecParameters.h264Wasm.frameHeight = 256;
  config.codecParameters.h264Wasm.frameWidth = 256;
  config.codecParameters.h264Wasm.videoFps = 2;
  config.qr = config.qr || {};
  config.qr.errorCorrectionLevel = 'H';
  config.qr.boxSize = 8;

  // 1. Chunk and generate QR PNGs
  const chunks = chunkText(SAMPLE_TEXT, config.chunkSize, config.overlap);
  await fs.mkdir(TEST_FRAMES_DIR, { recursive: true });
  for (let i = 0; i < chunks.length; i++) {
    const chunkPayload = JSON.stringify({ text: chunks[i], frame: i });
    const qrConfig = config.qr || {};
    const qrBuffer = await generateQrBuffer(chunkPayload, qrConfig);
    const frameName = path.join(TEST_FRAMES_DIR, `frame_${i.toString().padStart(6, '0')}.png`);
    await fs.writeFile(frameName, qrBuffer!);
  }

  // 2. Use fluent-ffmpeg to create video from PNGs
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(path.join(TEST_FRAMES_DIR, 'frame_%06d.png'))
      .inputFPS(config.codecParameters.h264Wasm.videoFps)
      .outputOptions([
        '-c:v', config.codecParameters.h264Wasm.codecNameInternal,
        '-s', `${config.codecParameters.h264Wasm.frameWidth}x${config.codecParameters.h264Wasm.frameHeight}`,
        '-pix_fmt', config.codecParameters.h264Wasm.pixFmt,
        '-preset', 'medium',
        '-tune', 'stillimage',
      ])
      .output(TEST_VIDEO)
      .on('end', (_stdout, _stderr) => resolve())
      .on('error', reject)
      .setFfmpegPath(ffmpegStatic as string)
      .run();
  });

  // 3. Extract frames from video
  const extractedFrames = await extractFramesFromVideo(TEST_VIDEO, TEST_EXTRACTED_FRAMES_DIR, config.codecParameters.h264Wasm.videoFps);
  console.log('Extracted frames:', extractedFrames);

  // 4. Decode QR from each frame
  const decodedChunks: string[] = [];
  for (const framePath of extractedFrames) {
    const qrText = await decodeQrFromPng(framePath);
    if (qrText) {
      try {
        const payload = JSON.parse(qrText);
        decodedChunks.push(payload.text);
      } catch (e) {
        // Ignore parse errors in cleanup version
      }
    }
  }
  console.log('Decoded chunks:', decodedChunks);

  // 5. Build Faiss index from decoded chunks
  const { TransformersEmbeddingModel } = await import('../src/embeddingModel');
  const embedder = new TransformersEmbeddingModel(config.embedding.model);
  const embeddings = await embedder.embed(decodedChunks);
  const faissIndex = new FaissIndexManager(config.embedding.dimension);
  await faissIndex.addChunks(embeddings, decodedChunks);

  // 6. Retrieve (native, faiss)
  const retriever = new MemvidRetrieverNative(faissIndex, embedder, config);
  const results = await retriever.search('liquor jugs', 1);
  if (results.length > 0 && results[0].includes('liquor jugs')) {
    console.log('E2E encode-retrieve test PASSED: Found expected chunk:', results[0]);
    await cleanup();
    process.exit(0);
  } else {
    console.error('E2E encode-retrieve test FAILED: Did not find expected chunk. Results:', results);
    await cleanup();
    process.exit(1);
  }
})().catch(async (err) => {
  console.error('E2E encode-retrieve test ERROR:', err);
  await cleanup();
  process.exit(2);
}); 
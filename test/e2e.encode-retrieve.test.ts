jest.unmock('hnswlib-wasm');
import { chunkText, generateQrBuffer } from '../src/utils';
import { MemvidRetriever } from '../src/retriever';
import { getDefaultConfig } from '../src/config';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const TEST_VIDEO = 'test_e2e_output.mp4';
const TEST_INDEX = 'test_e2e_index';
const TEST_FRAMES_DIR = 'test_e2e_frames';

const SAMPLE_TEXT = `The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow.`;

// Helper to clean up generated files
async function cleanup() {
  for (const ext of ['.mp4', '.hnsw', '.meta.json']) {
    try { await fs.unlink(TEST_INDEX + ext); } catch {}
  }
  try { await fs.unlink(TEST_VIDEO); } catch {}
  try { await fs.rm(TEST_FRAMES_DIR, { recursive: true, force: true }); } catch {}
}

describe('E2E: Encode and Retrieve (Node ffmpeg)', () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('should encode text into video and retrieve the correct chunk', async () => {
    const config = getDefaultConfig();
    config.index.path = TEST_INDEX;
    config.chunkSize = 40; // Small chunk size for test
    config.overlap = 0;
    config.embedding.model = 'Xenova/all-MiniLM-L6-v2';
    config.embedding.dimension = 384;
    config.codec = 'h264Wasm';
    config.codecParameters.h264Wasm.frameHeight = 256;
    config.codecParameters.h264Wasm.frameWidth = 256;
    config.codecParameters.h264Wasm.videoFps = 2;

    // 1. Chunk and generate QR PNGs
    const chunks = chunkText(SAMPLE_TEXT, config.chunkSize, config.overlap);
    await fs.mkdir(TEST_FRAMES_DIR, { recursive: true });
    const frameFiles: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPayload = JSON.stringify({ text: chunks[i], frame: i });
      const qrBuffer = await generateQrBuffer(chunkPayload, config.qr || {});
      const frameName = path.join(TEST_FRAMES_DIR, `frame_${i.toString().padStart(6, '0')}.png`);
      await fs.writeFile(frameName, qrBuffer!);
      frameFiles.push(frameName);
    }

    // 2. Use fluent-ffmpeg to create video from PNGs
    await new Promise((resolve, reject) => {
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
        .on('end', resolve)
        .on('error', reject)
        .setFfmpegPath(ffmpegStatic as string)
        .run();
    });

    // 3. Build index (simulate what encoder does)
    const { HNSWIndexManager } = require('../src/indexManager');
    const { TransformersEmbeddingModel } = require('../src/embeddingModel');
    const index = new HNSWIndexManager(new TransformersEmbeddingModel(config.embedding.model), config);
    await index.initIndex();
    const frameNumbers = Array.from({ length: chunks.length }, (_, i) => i);
    await index.addChunks(chunks, frameNumbers);
    const indexDataBuffer = await index.serializeIndex();
    await fs.writeFile(TEST_INDEX + '.hnsw', indexDataBuffer);
    // Save metadata as well
    await index.save(TEST_INDEX);

    // 4. Retrieve
    const retriever = new MemvidRetriever(TEST_VIDEO, TEST_INDEX, config);
    await retriever.readyPromise;
    const results = await retriever.search('liquor jugs', 1);
    expect(results.length).toBeGreaterThan(0);
    // The best chunk should contain the query phrase
    expect(results[0]).toContain('liquor jugs');
  }, 120000); // Allow up to 2min for E2E
}); 
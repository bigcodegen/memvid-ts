import { MemvidEncoder, MemvidRetriever, MemvidChat, getDefaultConfig } from './index.js';
import { promises as fs } from 'fs';

async function main() {
  // === ENCODING PHASE ===
  const config = getDefaultConfig();
  config.index.path = 'output/main_app_memory';
  config.qr = config.qr || {};
  config.qr.boxSize              = 8;
  config.qr.errorCorrectionLevel = 'M';
  config.codecParameters.h264Wasm.frameWidth  = 512;
  config.codecParameters.h264Wasm.frameHeight = 512;
  config.codecParameters.h264Wasm.videoFps    = 30;
  config.codec = 'h264Wasm';

  await fs.mkdir('output', { recursive: true });

  const encoder = new MemvidEncoder(config);

  // Add your text or documents here
  console.log("Loading text from data/pg200_middle30.txt...");
  const bookText = await fs.readFile("data/pg200_middle30.txt", "utf8");
  encoder.addText(bookText);
  // encoder.addPdf('path/to/document.pdf'); // Example for PDF

  console.log("Building video and index...");
  const { videoBuffer, indexDataBuffer, stats } = await encoder.buildVideo("output/main_app_video.mp4");
  await fs.writeFile("output/main_app_video.mp4", videoBuffer);
  // Index and metadata are saved by encoder internally

  console.log("Encoding complete:", stats);

  // === RETRIEVAL PHASE ===
  const retriever = new MemvidRetriever("output/main_app_video.mp4", config.index.path, config);
  await retriever.readyPromise;
  console.log("Retriever ready.");

  // Example search
  const results = await retriever.search("liquor jugs", 3);
  console.log("Search results:", results);

  // === CHAT PHASE (context-only, no LLM API key needed) ===
  const chat = new MemvidChat(retriever, config);
  chat.startSession();
  const chatResponse = await chat.chat("What is this video about?");
  console.log("Chatbot:", chatResponse);
}

main().catch(console.error);
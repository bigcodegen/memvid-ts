// Simple wrapper over transformers.js for embeddings
import { pipeline } from '@xenova/transformers';

export class TransformersEmbeddingModel {
  private ready: Promise<any>;
  private embedder: any;

  constructor(model: string = 'Xenova/all-MiniLM-L6-v2') {
    this.ready = (async () => {
      this.embedder = await pipeline('feature-extraction', model);
    })();
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ready;
    const embeddings = [] as number[][];
    for (const t of texts) {
      const tensor = await this.embedder(t, { pooling: 'mean', normalize: true });
      embeddings.push(Array.from(tensor.data));
    }
    return embeddings;
  }
}

// Jest manual mock for @xenova/transformers
module.exports = {
  pipeline: async (task, model) => {
    // Return a dummy embedding model
    return {
      embed: async (text) => [0.1, 0.2, 0.3], // Return a fixed embedding
    };
  },
}; 
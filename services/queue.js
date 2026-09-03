// ==========================================
// CMC SKILL HUB REQUEST QUEUE
// ==========================================
// Prevents overlapping requests, implements exponential backoff, and handles rate limits

class RequestQueue {
  constructor(maxConcurrent = 1, maxRetries = 3) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.maxRetries = maxRetries;
  }

  async add(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn,
        priority,
        resolve,
        reject,
      });

      this.queue.sort((a, b) => b.priority - a.priority);
      this.process();
    });
  }

  async process() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      this.running++;

      const { fn, resolve, reject } = this.queue.shift();

      try {
        const result = await this.executeWithRetry(fn);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        this.running--;
        this.process();
      }
    }
  }

  async executeWithRetry(fn, attempt = 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.log(`Retry ${attempt}/${this.maxRetries} after ${delay}ms:`, error.message);

        await new Promise((resolve) => setTimeout(resolve, delay));

        return this.executeWithRetry(fn, attempt + 1);
      }

      throw error;
    }
  }
}

module.exports = {
  RequestQueue,
};
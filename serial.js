export class SerialTransport {
  #port = null;
  #reader = null;
  #writer = null;
  #readBuffer = new Uint8Array(0);
  #pendingRead = null;

  get isOpen() {
    return Boolean(this.#port && this.#reader && this.#writer);
  }

  async requestAndOpen(baudRate = 115200) {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial is not supported in this browser");
    }

    this.#port = await navigator.serial.requestPort({});
    await this.#port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });

    this.#reader = this.#port.readable.getReader();
    this.#writer = this.#port.writable.getWriter();
  }

  async setSignals(signals) {
    if (!this.#port) {
      return;
    }
    await this.#port.setSignals(signals);
  }

  async writeBytes(bytes) {
    if (!this.#writer) {
      throw new Error("Serial writer is not available");
    }
    await this.#writer.write(bytes);
  }

  async readBytes(timeoutMs = 500) {
    if (!this.#reader) {
      throw new Error("Serial reader is not available");
    }

    // Reuse a pending read from a prior timeout instead of starting a new one.
    // Starting a second reader.read() while one is pending queues it behind the
    // first, causing data delivered to the old promise to be silently lost.
    if (!this.#pendingRead) {
      this.#pendingRead = this.#reader.read();
    }

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });

    const result = await Promise.race([this.#pendingRead, timeoutPromise]);
    if (result && result.timeout) {
      return new Uint8Array();
    }

    this.#pendingRead = null;

    if (result.done || !result.value) {
      return new Uint8Array();
    }
    return result.value;
  }

  async readExactly(length, timeoutMs = 1000) {
    if (length <= 0) {
      return new Uint8Array();
    }

    const deadline = Date.now() + timeoutMs;
    const chunks = [];
    let total = 0;

    if (this.#readBuffer.length) {
      const take = Math.min(length, this.#readBuffer.length);
      chunks.push(this.#readBuffer.slice(0, take));
      total += take;
      this.#readBuffer = this.#readBuffer.slice(take);
      if (total === length) {
        return this.#concatChunks(chunks, length);
      }
    }

    while (total < length) {
      const remainingMs = Math.max(1, deadline - Date.now());
      if (remainingMs <= 0) {
        throw new Error(`Serial read timeout while waiting for ${length} bytes`);
      }
      const chunk = await this.readBytes(remainingMs);
      if (!chunk.length) {
        if (Date.now() >= deadline) {
          throw new Error(`Serial read timeout while waiting for ${length} bytes`);
        }
        continue;
      }

      const need = length - total;
      if (chunk.length <= need) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        chunks.push(chunk.slice(0, need));
        total += need;
        this.#readBuffer = chunk.slice(need);
      }
    }

    return this.#concatChunks(chunks, length);
  }

  async readAvailable(timeoutMs = 150) {
    const chunk = await this.readBytes(timeoutMs);
    if (!chunk.length) {
      return this.#drainBuffered();
    }

    if (!this.#readBuffer.length) {
      return chunk;
    }

    const merged = new Uint8Array(this.#readBuffer.length + chunk.length);
    merged.set(this.#readBuffer, 0);
    merged.set(chunk, this.#readBuffer.length);
    this.#readBuffer = new Uint8Array(0);
    return merged;
  }

  #drainBuffered() {
    const data = this.#readBuffer;
    this.#readBuffer = new Uint8Array(0);
    return data;
  }

  #concatChunks(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async drain(totalMs = 500, quietMs = 120) {
    // Clear buffered bytes and wait until the line has been quiet for a
    // short window. A single read timeout does not guarantee no in-flight
    // bytes are still arriving from USB/CDC.
    this.#readBuffer = new Uint8Array(0);

    const deadline = Date.now() + totalMs;
    let lastDataAt = Date.now();
    let drainedBytes = 0;

    while (Date.now() < deadline) {
      const chunk = await this.readBytes(30);
      if (chunk.length) {
        drainedBytes += chunk.length;
        lastDataAt = Date.now();
        continue;
      }
      if (Date.now() - lastDataAt >= quietMs) {
        break;
      }
    }

    // Ensure no buffered leftovers remain after draining.
    this.#readBuffer = new Uint8Array(0);
    return drainedBytes;
  }

  async close() {
    this.#pendingRead = null;
    try {
      if (this.#reader) {
        await this.#reader.cancel();
      }
    } catch (_) {
      // Reader may already be released.
    }
    try {
      this.#reader?.releaseLock();
      this.#writer?.releaseLock();
      if (this.#port) {
        await this.#port.close();
      }
    } finally {
      this.#reader = null;
      this.#writer = null;
      this.#port = null;
      this.#readBuffer = new Uint8Array(0);
      this.#pendingRead = null;
    }
  }
}

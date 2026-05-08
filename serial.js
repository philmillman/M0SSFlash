export class SerialTransport {
  #port = null;
  #reader = null;
  #writer = null;
  #readBuffer = new Uint8Array(0);
  #readPump = null;
  #dataWaiters = [];
  #readError = null;
  #isClosing = false;

  get isOpen() {
    return Boolean(this.#port && this.#reader && this.#writer);
  }

  async requestAndOpen(baudRate = 921600) {
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
      bufferSize: 16384,
    });

    this.#reader = this.#port.readable.getReader();
    this.#writer = this.#port.writable.getWriter();
    this.#readError = null;
    this.#isClosing = false;
    this.#startReadPump();
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

    this.#throwReadErrorIfAny("readBytes");

    const buffered = this.#takeBuffered();
    if (buffered.length) {
      return buffered;
    }

    const wokeForData = await this.#waitForData(timeoutMs);
    if (!wokeForData) {
      return new Uint8Array();
    }

    this.#throwReadErrorIfAny("readBytes(post-wait)");
    return this.#takeBuffered();
  }

  async readExactly(length, timeoutMs = 1000) {
    if (length <= 0) {
      return new Uint8Array();
    }

    const deadline = Date.now() + timeoutMs;
    const chunks = [];
    let total = 0;

    if (this.#readBuffer.length) {
      const chunk = this.#takeBuffered(length);
      chunks.push(chunk);
      total += chunk.length;
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
    return this.readBytes(timeoutMs);
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
    // Consume buffered bytes first, then wait until the line has been quiet for
    // a short window. A single read timeout does not guarantee no in-flight
    // bytes are still arriving from USB/CDC.
    const deadline = Date.now() + totalMs;
    let lastDataAt = Date.now();
    let drainedBytes = 0;

    if (this.#readBuffer.length) {
      drainedBytes += this.#takeBuffered().length;
      lastDataAt = Date.now();
    }

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
    return drainedBytes;
  }

  async close() {
    this.#isClosing = true;
    this.#resolveWaiters();
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
      try {
        await this.#readPump;
      } catch (_) {
        // Ignore background pump failure during close.
      }
    } finally {
      this.#reader = null;
      this.#writer = null;
      this.#port = null;
      this.#readBuffer = new Uint8Array(0);
      this.#readPump = null;
      this.#dataWaiters = [];
      this.#readError = null;
      this.#isClosing = false;
    }
  }

  #startReadPump() {
    this.#readPump = (async () => {
      try {
        while (this.#reader && !this.#isClosing) {
          const { value, done } = await this.#reader.read();
          if (done) {
            break;
          }
          if (value?.length) {
            this.#appendToBuffer(value);
            this.#resolveWaiters();
          }
        }
      } catch (error) {
        if (!this.#isClosing) {
          this.#readError = error;
        }
      } finally {
        this.#resolveWaiters();
      }
    })();
  }

  #appendToBuffer(chunk) {
    if (!chunk?.length) {
      return;
    }
    if (!this.#readBuffer.length) {
      this.#readBuffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.#readBuffer.length + chunk.length);
    merged.set(this.#readBuffer, 0);
    merged.set(chunk, this.#readBuffer.length);
    this.#readBuffer = merged;
  }

  #takeBuffered(maxLength = null) {
    if (!this.#readBuffer.length) {
      return new Uint8Array(0);
    }
    const take = maxLength == null ? this.#readBuffer.length : Math.min(maxLength, this.#readBuffer.length);
    const data = this.#readBuffer.slice(0, take);
    this.#readBuffer = this.#readBuffer.slice(take);
    return data;
  }

  #waitForData(timeoutMs) {
    if (this.#readBuffer.length) {
      return Promise.resolve(true);
    }
    if (this.#readError || this.#isClosing || !this.#reader) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve: (hasData) => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          const index = this.#dataWaiters.indexOf(waiter);
          if (index !== -1) {
            this.#dataWaiters.splice(index, 1);
          }
          resolve(hasData);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => waiter.resolve(false), timeoutMs);
      this.#dataWaiters.push(waiter);
    });
  }

  #resolveWaiters() {
    if (!this.#dataWaiters.length) {
      return;
    }
    const hasData = this.#readBuffer.length > 0;
    for (const waiter of [...this.#dataWaiters]) {
      waiter.resolve(hasData);
    }
  }

  #throwReadErrorIfAny(context) {
    if (this.#readError) {
      const error = this.#readError;
      this.#readError = null;
      throw new Error(`Serial read error during ${context}: ${error.message}`);
    }
  }
}

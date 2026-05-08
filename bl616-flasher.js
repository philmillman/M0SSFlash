const DEFAULT_FLASH_ADDRESS = 0x00000000;
/** BL616 on-board SPI NOR is 4 MiB in typical M0SS / Bouffalo dev kits. */
const FLASH_SIZE_4MIB = 4 * 1024 * 1024;
/** Max time to wait for flash_erase when it returns PD (regional erase). */
const FLASH_ERASE_PENDING_DEADLINE_MS = 100000;
/** Full-chip erase can take much longer than a region erase. */
const FLASH_ERASE_FULL_CHIP_PENDING_DEADLINE_MS = 300000;
// Tuned stable profile for BL616 + JEDEC c86016 over Web Serial.
/** Bootrom allows up to 64 B per flash_write payload; Web Serial stays stable at 32 B. */
const CHUNK_SIZE = 128;
const MIN_CHUNK_SIZE = 32;
/**
 * Field logs: stable runs use 32 B frames + low ms pacing (see MIN_INTER_CHUNK_DELAY_MS).
 * We now allow probing up to 64 B with adaptive backoff/recovery.
 */
const MAX_FLASH_WRITE_CHUNK = 256;
/** Baseline pause between flash_write frames (Web Serial / bootrom pacing). */
const DEFAULT_INTER_CHUNK_DELAY_MS = 4;
const MIN_INTER_CHUNK_DELAY_MS = 3;
/** Extra pause every 4 KiB — helps Web Serial/CDC after long bursts (do not disable; caused verify SHA mismatch in the wild). */
const PER_4K_COOLDOWN_MS = 2;
/** Progress/log emit stride (bytes). Larger = less main-thread log churn during program. */
const PROGRAM_PROGRESS_STEP_BYTES = 8192;
/** Ease inter-chunk delay down to this band before trying larger `chunkSize` again (post-timeout delay often lands ~10–12 ms). */
const CHUNK_RESTORE_MAX_DELAY_MS = DEFAULT_INTER_CHUNK_DELAY_MS + 8;
const WRITE_ACK_TIMEOUT_NORMAL_MS = 8000;
const WRITE_RETRIES_NORMAL = 3;
const WRITE_ACK_TIMEOUT_SMALL_MS = 2500; // <= 64 bytes
const WRITE_RETRIES_SMALL = 2;
const WRITE_ACK_TIMEOUT_MIN_MS = 3000; // <= 32 bytes
const WRITE_RETRIES_MIN = 2;
const BASE_MAX_RECOVERY_ATTEMPTS = 8;
const MAX_RECOVERY_ATTEMPTS_WITH_PROGRESS = 20;
const OK_BYTE_1 = 0x4f;
const OK_BYTE_2 = 0x4b;
const PD_BYTE_1 = 0x50;
const PD_BYTE_2 = 0x44;

const PHASE = {
  IDLE: "idle",
  PORT_OPEN: "port_open",
  BOOTLOADER_ENTRY: "bootloader_entry",
  HANDSHAKE: "handshake",
  PROGRAM: "program",
  VERIFY: "verify",
  SUCCESS: "success",
  ERROR: "error",
};

const FLASH_CLOCK_CFG = 0x41;
const FLASH_IO_MODE = 0x01;
const FLASH_CLK_DELAY = 0x00;

// Generated from bflb-mcu-tool BL616 flash configs.
const FLASH_PARA_BY_JEDEC = {
  c86016:
    "040100006699ff039f00b7e904c80001c72052d8060232000b010b013b01bb006b01eb02eb02025000010001010002010201ab01053500000101000038ffa0ff77030240770302f02c01b004b0040500e8801400",
  ef4016:
    "040100006699ff039f00b7e904ef0001c72052d8060232000b010b013b01bb006b01eb02eb02025000010001010002010101ab01053500000131000038ffa0ff77030240770302f02c01b004b0040500e8800300",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeU16LE(value) {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function encodeU32LE(value) {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ]);
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class Bl616Flasher {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.textDecoder = new TextDecoder();
    this.bootInfoHex = "";
    this.flashSetConfig = 0;
    this.recoveryCount = 0;
    this.recoveryAttemptLimit = BASE_MAX_RECOVERY_ATTEMPTS;
    this.lastRecoveryOffset = null;
  }

  emit(phase, message, progress = null, level = "info") {
    if (this.handlers?.onEvent) {
      this.handlers.onEvent({ phase, message, progress, level });
    }
  }

  async flashSingleBin(file, bytes, options = {}) {
    if (!this.transport.isOpen) {
      throw new Error("Serial port is not connected");
    }

    const { eraseFullFlash = false } = options;

    this.emit(PHASE.PORT_OPEN, "Serial port connected", 0);
    this.recoveryCount = 0;
    this.recoveryAttemptLimit = BASE_MAX_RECOVERY_ATTEMPTS;
    this.lastRecoveryOffset = null;
    await this.enterBootloaderMode();
    await this.handshakeWithRetry();
    await this.getBootInfo();
    await this.setBootromUartTimeout(10000);
    await this.programBin(file, bytes, DEFAULT_FLASH_ADDRESS, { eraseFullFlash });
    await this.verifyWrite(bytes);
    this.emit(PHASE.SUCCESS, "Flash completed", 100);
  }

  async enterBootloaderMode() {
    this.emit(
      PHASE.BOOTLOADER_ENTRY,
      "Entering bootloader mode. Put the board in BOOT mode if needed.",
      5
    );

    try {
      // Many boards map DTR/RTS to reset/boot. This is best-effort.
      await this.transport.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(50);
      await this.transport.setSignals({ dataTerminalReady: true, requestToSend: false });
      await sleep(100);
    } catch (_) {
      this.emit(
        PHASE.BOOTLOADER_ENTRY,
        "Could not toggle control lines; continue with manual BOOT+RESET",
        5,
        "warn"
      );
    }
  }

  async handshakeWithRetry() {
    this.emit(PHASE.HANDSHAKE, "Sending sync", 10);

    const ok = await this.tryHandshake();
    if (ok) {
      this.emit(PHASE.HANDSHAKE, "Handshake success", 15);
      return;
    }

    this.emit(
      PHASE.HANDSHAKE,
      "No ACK. Re-entering boot mode and retrying once...",
      10,
      "warn"
    );
    await this.enterBootloaderMode();
    const retryOk = await this.tryHandshake();
    if (!retryOk) {
      throw new Error("Handshake failed. Put BL616 in bootloader mode and retry.");
    }
    this.emit(PHASE.HANDSHAKE, "Handshake success (retry)", 15);
  }

  async tryHandshake() {
    // Drain stale data before sync (matches Python tool's read_all before sync).
    await this.transport.drain();

    // Match bflb UART handshake pulse: ~6ms of 0x55 at 115200.
    const pulseLen = Math.max(16, Math.floor((0.006 * 115200) / 10));
    const sync = new Uint8Array(pulseLen).fill(0x55);
    await this.transport.writeBytes(sync);
    const response = await this.transport.readAvailable(600);
    if (!response.length) {
      return false;
    }
    for (let i = 0; i < response.length - 1; i += 1) {
      const b0 = response[i];
      const b1 = response[i + 1];
      const isOkPair =
        (b0 === OK_BYTE_1 && b1 === OK_BYTE_2) ||
        (b0 === OK_BYTE_2 && b1 === OK_BYTE_1);
      if (isOkPair) {
        await sleep(30);
        return true;
      }
    }
    return false;
  }

  async getBootInfo() {
    const { response } = await this.sendCommand(0x10, new Uint8Array(), true, "get_boot_info", {
      ackTimeoutMs: 3000,
      retries: 1,
    });
    this.bootInfoHex = toHex(response);
    this.emit(PHASE.HANDSHAKE, `Boot info: ${this.bootInfoHex}`, 18);
  }

  computeFlashPinFromBootInfo() {
    if (!this.bootInfoHex || this.bootInfoHex.length < 24) {
      return 0x02;
    }
    // Match bflb flash_get_pin_from_bootinfo for bl616.
    const swUsageHex =
      this.bootInfoHex.slice(22, 24) +
      this.bootInfoHex.slice(20, 22) +
      this.bootInfoHex.slice(18, 20) +
      this.bootInfoHex.slice(16, 18);
    const swUsage = parseInt(swUsageHex, 16);
    return (swUsage >> 14) & 0x3f;
  }

  async setupFlashParameters() {
    // Purge any trailing bytes left by prior response commands (especially
    // get_boot_info) before beginning flash-control commands.
    const drained = await this.transport.drain(800, 180);
    if (drained > 0) {
      this.emit(PHASE.PROGRAM, `Pre-flash drain cleared ${drained} byte(s)`, 19, "warn");
    }

    const flashPin = this.computeFlashPinFromBootInfo();
    this.flashSetConfig =
      flashPin + (FLASH_CLOCK_CFG << 8) + (FLASH_IO_MODE << 16) + (FLASH_CLK_DELAY << 24);

    this.emit(PHASE.PROGRAM, `Flash cfg pin=0x${flashPin.toString(16)} set=0x${this.flashSetConfig.toString(16)}`, 19);

    // Step 1: configure the flash controller with base pin/clock/mode settings.
    // This MUST happen before any flash operations (including JEDEC read).
    // The Python tool does this first in flash_program_main_process.
    await this.sendCommand(
      0x3b,
      encodeU32LE(this.flashSetConfig),
      false,
      "flash_set_para",
      { retries: 2 }
    );
    this.emit(PHASE.PROGRAM, "Flash controller configured", 20);

    // Step 2: read JEDEC ID (now possible because flash controller is set up).
    let jedec = "c86016";
    try {
      const { response } = await this.sendCommand(0x36, new Uint8Array(), true, "flash_read_jedec_id");
      jedec = toHex(response.slice(0, 3));
      this.emit(PHASE.PROGRAM, `JEDEC ID: ${jedec}`, 20);
    } catch (error) {
      this.emit(
        PHASE.PROGRAM,
        `flash_read_jedec_id failed (${error.message}); using fallback JEDEC ${jedec}`,
        20,
        "warn"
      );
    }

    // Step 3: apply JEDEC-specific flash timing parameters if available.
    const paraHex = FLASH_PARA_BY_JEDEC[jedec];
    if (paraHex) {
      const paraBytes = this.hexToBytes(paraHex);
      try {
        await this.sendCommand(
          0x3b,
          this.concatBytes(encodeU32LE(this.flashSetConfig), paraBytes),
          false,
          "flash_set_para(tuned)"
        );
        this.emit(PHASE.PROGRAM, `Flash params applied for ${jedec}`, 21);
      } catch (error) {
        this.emit(PHASE.PROGRAM, `flash_set_para(tuned) failed: ${error.message}`, 20, "warn");
      }
    }
  }

  async setBootromUartTimeout(timeoutMs) {
    // BL616 ax path in bflb_mcu_tool uses cmd 0x23 before long operations.
    const payload = encodeU32LE(timeoutMs >>> 0);
    await this.sendCommand(0x23, payload, false, "set_timeout", {
      ackTimeoutMs: 2000,
      retries: 1,
    });
    this.emit(PHASE.HANDSHAKE, `Bootrom UART timeout set to ${timeoutMs}ms`, 19);
  }

  async programBin(file, bytes, startAddress, options = {}) {
    const { eraseFullFlash = false } = options;

    this.emit(
      PHASE.PROGRAM,
      `Programming ${file.name} at 0x${startAddress.toString(16).padStart(8, "0")}`,
      20
    );

    await this.setupFlashParameters();

    if (eraseFullFlash) {
      const fullEnd = FLASH_SIZE_4MIB - 1;
      this.emit(
        PHASE.PROGRAM,
        `Erasing full 4 MiB flash (0x00000000-0x${fullEnd.toString(16)})`,
        21
      );
      await this.flashErase(0, fullEnd, {
        pendingDeadlineMs: FLASH_ERASE_FULL_CHIP_PENDING_DEADLINE_MS,
      });
      this.emit(PHASE.PROGRAM, "Full flash erase complete", 22);
    }

    const endAddress = startAddress + bytes.length - 1;
    this.emit(PHASE.PROGRAM, "Erasing flash region", 22);
    await this.flashErase(startAddress, endAddress);
    this.emit(PHASE.PROGRAM, "Erase complete", 24);

    let sent = 0;
    let chunkSize = Math.min(CHUNK_SIZE, MAX_FLASH_WRITE_CHUNK);
    let interChunkDelayMs = MIN_INTER_CHUNK_DELAY_MS;
    let writeOkStreak = 0;
    while (sent < bytes.length) {
      const end = Math.min(sent + chunkSize, bytes.length);
      const chunk = bytes.slice(sent, end); // Uint8Array slice
      const payload = this.concatBytes(encodeU32LE(startAddress + sent), chunk);
      let writeAckTimeoutMs = WRITE_ACK_TIMEOUT_NORMAL_MS;
      let writeRetries = WRITE_RETRIES_NORMAL;
      if (chunkSize <= MIN_CHUNK_SIZE) {
        // Keep minimum-size writes conservative for reliability.
        writeAckTimeoutMs = WRITE_ACK_TIMEOUT_MIN_MS;
        writeRetries = WRITE_RETRIES_MIN;
      } else if (chunkSize <= 64) {
        writeAckTimeoutMs = WRITE_ACK_TIMEOUT_SMALL_MS;
        writeRetries = WRITE_RETRIES_SMALL;
      }

      try {
        await this.sendCommand(0x31, payload, false, "flash_write", {
          ackTimeoutMs: writeAckTimeoutMs,
          retries: writeRetries,
          settlePending: true,
          pendingTimeoutMs: 10000,
        });
        sent = end;
        const progress = 20 + Math.round((sent / bytes.length) * 65);
        if (sent % PROGRAM_PROGRESS_STEP_BYTES === 0 || sent === bytes.length) {
          this.emit(PHASE.PROGRAM, `Wrote ${sent}/${bytes.length} bytes`, progress);
        }
        writeOkStreak += 1;
        // After many clean writes, ease backoff so a transient timeout does not
        // leave inter-chunk delay pegged high for the rest of the image.
        const relaxEvery = chunkSize === MIN_CHUNK_SIZE ? 64 : 128;
        if (writeOkStreak % relaxEvery === 0 && interChunkDelayMs > MIN_INTER_CHUNK_DELAY_MS) {
          interChunkDelayMs = Math.max(MIN_INTER_CHUNK_DELAY_MS, interChunkDelayMs - 2);
        }
        if (
          writeOkStreak % 256 === 0 &&
          chunkSize < MAX_FLASH_WRITE_CHUNK &&
          interChunkDelayMs <= CHUNK_RESTORE_MAX_DELAY_MS
        ) {
          chunkSize = Math.min(MAX_FLASH_WRITE_CHUNK, chunkSize * 2);
        }
        // Brief pause between chunks -- the Python tool has natural latency
        // from its serial library; without this, the bootrom can drop frames.
        await sleep(interChunkDelayMs);
        if (sent % 4096 === 0 && PER_4K_COOLDOWN_MS > 0) {
          await sleep(PER_4K_COOLDOWN_MS);
        }
      } catch (error) {
        writeOkStreak = 0;
        const isReadTimeout =
          typeof error?.message === "string" &&
          error.message.includes("Serial read timeout while waiting for 2 bytes");

        const isFl0001 =
          typeof error?.message === "string" &&
          error.message.includes("FL0001");

        if (isReadTimeout) {
          const drained = await this.transport.drain(600, 160);
          this.emit(
            PHASE.PROGRAM,
            `Write timeout at offset ${sent}. Backing off (cleared=${drained})`,
            null,
            "warn"
          );
          if (drained > 0) {
            interChunkDelayMs = Math.min(40, interChunkDelayMs + 6);
          }
        }

        if (chunkSize > MIN_CHUNK_SIZE) {
          chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
          this.emit(
            PHASE.PROGRAM,
            `Write unstable at offset ${sent}. Reducing chunk size to ${chunkSize}, delay ${interChunkDelayMs}ms`,
            null,
            "warn"
          );
          continue;
        }

        if (isReadTimeout) {
          this.emit(
            PHASE.PROGRAM,
            `Still timing out at minimum chunk. Re-handshaking at offset ${sent}`,
            null,
            "warn"
          );
          await this.recoverWriteChannel(sent);
          await this.setupFlashParameters();
          continue;
        }
        if (isFl0001) {
          this.emit(
            PHASE.PROGRAM,
            `flash_write returned FL0001 at offset ${sent}. Re-handshaking and retrying`,
            null,
            "warn"
          );
          await this.recoverWriteChannel(sent);
          await this.setupFlashParameters();
          continue;
        }
        throw error;
      }
    }

    await this.transport.drain(800, 180);

    await this.sendCommand(0x3a, new Uint8Array(), false, "flash_write_check", {
      ackTimeoutMs: 5000,
      retries: 2,
    });
  }

  async verifyWrite(bytes) {
    this.emit(PHASE.VERIFY, "Verifying write", 90);

    await this.transport.drain(800, 180);
    await this.sendCommand(0x60, new Uint8Array(), false, "flash_xip_read_start");
    const shaPayload = this.concatBytes(encodeU32LE(DEFAULT_FLASH_ADDRESS), encodeU32LE(bytes.length));
    const { response } = await this.sendCommand(0x3e, shaPayload, true, "flash_xip_readSha");
    await this.sendCommand(0x61, new Uint8Array(), false, "flash_xip_read_finish");

    const expectedSha = await this.sha256Hex(bytes);
    const deviceSha = toHex(response).slice(0, 64);
    if (!deviceSha) {
      throw new Error("Verify failed: empty SHA response");
    }
    if (expectedSha !== deviceSha) {
      throw new Error(`Verify mismatch. host=${expectedSha} device=${deviceSha}`);
    }
    this.emit(PHASE.VERIFY, "Verify success", 98);
  }

  async flashErase(startAddress, endAddress, eraseOptions = {}) {
    const pendingDeadlineMs = eraseOptions.pendingDeadlineMs ?? FLASH_ERASE_PENDING_DEADLINE_MS;
    const payload = this.concatBytes(encodeU32LE(startAddress), encodeU32LE(endAddress));
    const result = await this.sendCommand(0x30, payload, false, "flash_erase", {
      ackTimeoutMs: 10000,
      retries: 2,
    });
    if (result.status === "PD") {
      const deadline = Date.now() + pendingDeadlineMs;
      while (Date.now() < deadline) {
        const ack = await this.readAck(3000);
        if (ack === "PD") {
          this.emit(PHASE.PROGRAM, "Erase pending...", 23);
          continue;
        }
        if (ack === "OK") {
          break;
        }
        throw new Error(`Flash erase failed: ${ack}`);
      }
      if (Date.now() >= deadline) {
        throw new Error("Flash erase timeout");
      }
    }
    // Clear any stale PD/OK bytes left in the UART FIFO after erase.
    // The Python tool does: if_set_rx_timeout(0.02); if_read(1000)
    await this.transport.drain();
  }

  async sendCommand(cmd, payload, expectsResponse, name, options = {}) {
    const ackTimeoutMs = options.ackTimeoutMs ?? 2000;
    const retries = options.retries ?? 0;
    const settlePending = options.settlePending ?? false;
    const pendingTimeoutMs = options.pendingTimeoutMs ?? Math.max(ackTimeoutMs, 6000);

    let attempt = 0;
    while (true) {
      try {
        const frame = this.buildFrame(cmd, payload);
        await this.transport.writeBytes(frame);

        let status = await this.readAck(ackTimeoutMs);
        if (status !== "OK" && status !== "PD") {
          throw new Error(`${name} failed: ${status}`);
        }
        if (status === "PD" && settlePending) {
          status = await this.waitForOkAfterPending(name, pendingTimeoutMs);
        }
        if (status === "PD" || !expectsResponse) {
          return { status, response: new Uint8Array() };
        }

        // Match bflb if_deal_response(): occasionally extra "OK" bytes can
        // appear before the actual 2-byte response length.
        let lenBytes = await this.transport.readExactly(2, 4000);
        let guard = 0;
        while (lenBytes[0] === OK_BYTE_1 && lenBytes[1] === OK_BYTE_2 && guard < 8) {
          lenBytes = await this.transport.readExactly(2, 1200);
          guard += 1;
        }

        const dataLen = lenBytes[0] | (lenBytes[1] << 8);
        const response = dataLen ? await this.transport.readExactly(dataLen, 3000) : new Uint8Array();
        // The bootrom sometimes sends trailing bytes beyond the declared
        // response length (seen with get_boot_info). Drain them so they
        // don't corrupt subsequent command framing.
        await this.transport.drain();
        return { status, response };
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }
        attempt += 1;
        // Do not sniff with readAvailable() here: it consumes bytes and can
        // desync command framing. Drain stale bytes and report count instead.
        const drained = await this.transport.drain(400, 120);
        const drainNote = drained > 0 ? ` cleared=${drained}` : " cleared=0";
        this.emit(PHASE.PROGRAM, `${name} retry ${attempt}/${retries}${drainNote}`, null, "warn");
        await sleep(50);
      }
    }
  }

  async waitForOkAfterPending(name, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ack = await this.readAck(Math.min(1500, Math.max(1, deadline - Date.now())));
      if (ack === "PD") {
        continue;
      }
      if (ack === "OK") {
        return "OK";
      }
      throw new Error(`${name} failed while pending: ${ack}`);
    }
    throw new Error(`${name} pending timeout`);
  }

  async recoverWriteChannel(offset) {
    const madeProgressSinceLastRecovery =
      this.lastRecoveryOffset !== null && offset > this.lastRecoveryOffset;
    if (madeProgressSinceLastRecovery && this.recoveryAttemptLimit < MAX_RECOVERY_ATTEMPTS_WITH_PROGRESS) {
      this.recoveryAttemptLimit += 1;
      this.emit(
        PHASE.PROGRAM,
        `Recovery budget increased to ${this.recoveryAttemptLimit} (progress observed)`,
        null
      );
    }

    this.recoveryCount += 1;
    if (this.recoveryCount > this.recoveryAttemptLimit) {
      throw new Error(
        `Write recovery exceeded ${this.recoveryAttemptLimit} attempts at offset ${offset}. ` +
        "Please re-enter BOOT mode and retry flashing."
      );
    }
    const doRecoveryAttempt = async () => {
      await this.handshakeWithRetry();
      await this.getBootInfo();
      await this.setBootromUartTimeout(10000);
    };

    try {
      await doRecoveryAttempt();
    } catch (firstErr) {
      this.emit(
        PHASE.PROGRAM,
        `Recovery attempt failed (${firstErr.message}). Re-entering BOOT mode and retrying`,
        null,
        "warn"
      );
      await this.enterBootloaderMode();
      await doRecoveryAttempt();
    }

    const drained = await this.transport.drain(500, 140);
    if (drained > 0) {
      this.emit(PHASE.PROGRAM, `Recovery drain cleared ${drained} byte(s)`, null, "warn");
    }
    this.lastRecoveryOffset = offset;
    this.emit(
      PHASE.PROGRAM,
      `Recovery complete (#${this.recoveryCount}/${this.recoveryAttemptLimit}) at offset ${offset}`,
      null
    );
  }

  buildFrame(cmd, payload) {
    let checksum = payload.length & 0xff;
    checksum = (checksum + ((payload.length >> 8) & 0xff)) & 0xff;
    for (let i = 0; i < payload.length; i += 1) {
      checksum = (checksum + payload[i]) & 0xff;
    }
    return this.concatBytes(
      new Uint8Array([cmd & 0xff, checksum & 0xff]),
      encodeU16LE(payload.length),
      payload
    );
  }

  async readAck(timeoutMs) {
    // Read exactly 2 bytes for the ACK, matching the reference Python tool's
    // if_deal_ack(). The old scanning approach consumed response data that
    // arrived in the same USB frame as the ACK, corrupting subsequent reads.
    const ack = await this.transport.readExactly(2, timeoutMs);

    const isOk =
      (ack[0] === OK_BYTE_1 && ack[1] === OK_BYTE_2) ||
      (ack[0] === OK_BYTE_2 && ack[1] === OK_BYTE_1);
    if (isOk) {
      return "OK";
    }
    const isPending =
      (ack[0] === PD_BYTE_1 && ack[1] === PD_BYTE_2) ||
      (ack[0] === PD_BYTE_2 && ack[1] === PD_BYTE_1);
    if (isPending) {
      return "PD";
    }

    try {
      const err = await this.transport.readExactly(2, 300);
      const errCode = (err[1] << 8) | err[0];
      return `FL${errCode.toString(16).padStart(4, "0")}`;
    } catch (_) {
      return `FL(ack=${toHex(ack)})`;
    }
  }

  concatBytes(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      out.set(arr, offset);
      offset += arr.length;
    }
    return out;
  }

  async sha256Hex(bytes) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return toHex(new Uint8Array(hash));
  }

  hexToBytes(hex) {
    if (hex.length % 2 !== 0) {
      throw new Error("Invalid hex length");
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
}

export { PHASE };

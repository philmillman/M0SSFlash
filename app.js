import { SerialTransport } from "./serial.js";
import { Bl616Flasher } from "./bl616-flasher.js";

const firmwareInput = document.querySelector("#firmware-input");
const dropZone = document.querySelector("#drop-zone");
const dropZoneText = document.querySelector("#drop-zone-text");
const fileMeta = document.querySelector("#file-meta");
const connectBtn = document.querySelector("#connect-btn");
const flashBtn = document.querySelector("#flash-btn");
const disconnectBtn = document.querySelector("#disconnect-btn");
const statusText = document.querySelector("#status-text");
const phaseText = document.querySelector("#phase-text");
const progressBar = document.querySelector("#progress");
const logOutput = document.querySelector("#log-output");

const transport = new SerialTransport();
const flasher = new Bl616Flasher(transport, { onEvent: onFlasherEvent });

let selectedFile = null;
let selectedBytes = null;
let isBusy = false;

if (!("serial" in navigator)) {
  connectBtn.disabled = true;
  flashBtn.disabled = true;
  setStatus(
    "Web Serial not available. Use a Chromium-based browser (Chrome/Edge/Brave).",
    "error"
  );
}

function appendLog(message) {
  const ts = new Date().toLocaleTimeString();
  logOutput.textContent += `[${ts}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setStatus(message, level = "info") {
  statusText.textContent = message;
  statusText.dataset.level = level;
}

function setFile(file, bytes) {
  selectedFile = file;
  selectedBytes = bytes;
  fileMeta.textContent = `${file.name} (${bytes.length.toLocaleString()} bytes)`;
  dropZoneText.innerHTML = `Ready: <code>${file.name}</code>`;
  updateButtons();
  appendLog(`Selected firmware: ${file.name}`);
  if (!transport.isOpen) {
    setStatus("Firmware loaded. Connect Serial to enable flashing.");
  }
}

function updateButtons() {
  const hasFirmware = Boolean(selectedFile && selectedBytes);
  connectBtn.disabled = isBusy || !("serial" in navigator);
  disconnectBtn.disabled = isBusy || !transport.isOpen;
  flashBtn.disabled = isBusy || !hasFirmware || !transport.isOpen;
}

function onFlasherEvent(evt) {
  phaseText.textContent = evt.phase;
  if (typeof evt.progress === "number") {
    progressBar.value = evt.progress;
  }
  const prefix = evt.level === "warn" ? "WARN" : "INFO";
  appendLog(`${prefix} ${evt.phase}: ${evt.message}`);
}

async function readSelectedFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

async function onFilePicked(file) {
  if (!file) {
    return;
  }
  if (!file.name.toLowerCase().endsWith(".bin")) {
    setStatus("Please choose a .bin firmware file", "error");
    appendLog("Rejected file: not a .bin");
    return;
  }
  const bytes = await readSelectedFile(file);
  if (!bytes.length) {
    setStatus("Firmware file is empty", "error");
    return;
  }
  setFile(file, bytes);
  setStatus("Firmware loaded");
}

firmwareInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await onFilePicked(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = event.dataTransfer?.files?.[0];
  await onFilePicked(file);
});

connectBtn.addEventListener("click", async () => {
  try {
    isBusy = true;
    updateButtons();
    setStatus("Requesting serial port...");
    appendLog("Opening serial port at 115200");
    await transport.requestAndOpen(115200);
    setStatus("Serial connected");
    appendLog("Serial port connected");
  } catch (error) {
    setStatus(`Connect failed: ${error.message}`, "error");
    appendLog(`ERROR connect: ${error.message}`);
  } finally {
    isBusy = false;
    updateButtons();
  }
});

flashBtn.addEventListener("click", async () => {
  if (!selectedFile || !selectedBytes) {
    return;
  }
  if (!transport.isOpen) {
    setStatus("Connect Serial first", "error");
    appendLog("ERROR flash: serial port is not connected");
    return;
  }
  try {
    isBusy = true;
    progressBar.value = 0;
    updateButtons();
    setStatus("Flashing...");
    appendLog(`Starting flash: ${selectedFile.name}`);
    await flasher.flashSingleBin(selectedFile, selectedBytes);
    setStatus("Flash finished");
    appendLog("Flash complete");
  } catch (error) {
    setStatus(`Flash failed: ${error.message}`, "error");
    appendLog(`ERROR flash: ${error.message}`);
  } finally {
    isBusy = false;
    updateButtons();
  }
});

disconnectBtn.addEventListener("click", async () => {
  try {
    await transport.close();
    setStatus("Disconnected");
    appendLog("Serial port closed");
  } catch (error) {
    setStatus(`Disconnect failed: ${error.message}`, "error");
    appendLog(`ERROR disconnect: ${error.message}`);
  } finally {
    updateButtons();
  }
});

updateButtons();

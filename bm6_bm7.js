#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const Pushover = require("node-pushover");

const BM6_KEY = Buffer.from([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 57]);
const BM7_KEY = Buffer.from([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 64]);
const COMMAND_HEX = "d1550700000000000000000000000000";
const NOTIFY_UUID = "fff4";
const WRITE_UUID = "fff3";

const DEFAULT_SCAN_MS = 7000;
const DEFAULT_CONNECT_SCAN_MS = 12000;
const DEFAULT_READ_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_HOURS = null;

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_SCHEDULE_HOUR = 8;
const DEFAULT_SCHEDULE_MINUTE = 0;
const DEFAULT_LOW_SOC_THRESHOLD = 50;
const DEFAULT_PUSHOVER_TITLE = "Vehicle Battery Low";

const CONFIG_PATH = path.join(__dirname, "config.json");
const CONFIG_TEMPLATE_PATH = path.join(__dirname, "config.json.default");

function parseArgs(argv) {
  const args = {
    format: "ascii",
    scan: false,
    map: false,
    generateConfig: false,
    bm6: null,
    bm7: null,
    scanMs: DEFAULT_SCAN_MS,
    connectScanMs: DEFAULT_CONNECT_SCAN_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    intervalHours: DEFAULT_INTERVAL_HOURS,
    once: false,
    screen: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      args.format = argv[i + 1] || args.format;
      i += 1;
    } else if (arg === "--scan") {
      args.scan = true;
    } else if (arg === "--map") {
      args.map = true;
    } else if (arg === "--generate-config") {
      args.generateConfig = true;
    } else if (arg === "--bm6") {
      args.bm6 = argv[i + 1];
      i += 1;
    } else if (arg === "--bm7") {
      args.bm7 = argv[i + 1];
      i += 1;
    } else if (arg === "--scan-ms") {
      args.scanMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--connect-scan-ms") {
      args.connectScanMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--read-timeout-ms") {
      args.readTimeoutMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--interval-hours") {
      args.intervalHours = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--screen") {
      args.screen = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function printUsage() {
  const usage = [
    "Usage:",
    "  node bm6_bm7.js --scan [--format ascii|json]",
    "  node bm6_bm7.js --generate-config [--scan-ms 7000]",
    "  node bm6_bm7.js --map [--once] [--interval-hours <h>] [--format ascii|json]",
    "  node bm6_bm7.js --bm6 <address> --bm7 <address> [--format ascii|json]",
    "",
    "Options:",
    "  --scan                Scan for BM6 and BM7 devices",
    "  --generate-config     Scan and create config.json interactively",
    "  --map                 Read devices from config.json (daily at 08:00 in config time zone)",
    "  --bm6 <address>       MAC address for a BM6 monitor",
    "  --bm7 <address>       MAC address for a BM7 (BM300 Pro) monitor",
    "  --format <format>     ascii (default) or json",
    "  --scan-ms <ms>        Scan duration when using --scan (default: 7000)",
    "  --connect-scan-ms <ms>Scan duration when finding devices (default: 12000)",
    "  --read-timeout-ms <ms>Timeout waiting for data (default: 10000)",
    "  --interval-hours <h>  Interval for --map reads (overrides daily schedule)",
    "  --once                Run a single --map read and exit",
    "  --screen              Print results only; disable push notifications",
  ];
  console.log(usage.join("\n"));
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadConfigOrThrow() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Run with --generate-config or copy ${CONFIG_TEMPLATE_PATH} to ${CONFIG_PATH}.`
    );
  }
  return readJsonFile(CONFIG_PATH);
}

function normalizeConfig(config) {
  const schedule = config.schedule || {};
  const pushover = config.pushover || {};

  return {
    schedule: {
      timeZone: schedule.timeZone || DEFAULT_TIME_ZONE,
      hour: Number.isFinite(schedule.hour) ? schedule.hour : DEFAULT_SCHEDULE_HOUR,
      minute: Number.isFinite(schedule.minute) ? schedule.minute : DEFAULT_SCHEDULE_MINUTE,
    },
    lowSocThreshold: Number.isFinite(config.lowSocThreshold)
      ? config.lowSocThreshold
      : DEFAULT_LOW_SOC_THRESHOLD,
    pushover: {
      enabled: pushover.enabled !== false,
      userKey: pushover.userKey || "",
      appToken: pushover.appToken || "",
      title: pushover.title || DEFAULT_PUSHOVER_TITLE,
    },
    devices: Array.isArray(config.devices) ? config.devices : [],
  };
}

function buildNotification(config, args) {
  const enabled = config.pushover.enabled && !args.screen;
  const hasKeys = Boolean(config.pushover.userKey && config.pushover.appToken);
  const pushClient = enabled && hasKeys
    ? new Pushover({
        token: config.pushover.appToken,
        user: config.pushover.userKey,
      })
    : null;

  return {
    enabled,
    pushClient,
  };
}

function normalizeAddress(address) {
  if (!address) {
    return "";
  }
  return String(address).toLowerCase();
}

function isBmDeviceName(name) {
  return name === "BM6" || name === "BM300 Pro";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePoweredBluez(adapter) {
  const powered = await adapter.isPowered();
  if (!powered) {
    throw new Error("Bluetooth adapter is not powered on.");
  }
}

async function scanDevicesBluez(adapter, scanMs) {
  await ensurePoweredBluez(adapter);
  const wasDiscovering = await adapter.isDiscovering();
  if (!wasDiscovering) {
    await adapter.startDiscovery();
  }

  await wait(scanMs);
  const deviceIds = await adapter.devices();

  const results = [];
  for (const id of deviceIds) {
    const device = await adapter.getDevice(id);
    let name = "";
    try {
      name = await device.getName();
    } catch (err) {
      name = "";
    }
    if (isBmDeviceName(name)) {
      let rssi = null;
      try {
        rssi = await device.getRSSI();
      } catch (err) {
        rssi = null;
      }
      let address = "";
      try {
        address = await device.getAddress();
      } catch (err) {
        address = id;
      }
      results.push({
        address: normalizeAddress(address || id),
        rssi,
        name,
      });
    }
  }

  if (!wasDiscovering) {
    await adapter.stopDiscovery();
  }

  return results;
}

async function findDevicesByAddressBluez(adapter, addresses, scanMs) {
  const targets = addresses.map(normalizeAddress);
  const found = new Map();

  await ensurePoweredBluez(adapter);
  const wasDiscovering = await adapter.isDiscovering();
  if (!wasDiscovering) {
    await adapter.startDiscovery();
  }

  const results = await Promise.all(
    targets.map(async (address) => {
      try {
        const device = await adapter.waitDevice(address, scanMs, 1000);
        return { address, device };
      } catch (err) {
        return null;
      }
    })
  );

  results.forEach((result) => {
    if (result) {
      found.set(result.address, result.device);
    }
  });

  if (!wasDiscovering) {
    await adapter.stopDiscovery();
  }

  return found;
}

function waitForNobleState(noble, timeoutMs) {
  if (noble.state && noble.state !== "unknown") {
    return Promise.resolve(noble.state);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(noble.state || "unknown");
    }, timeoutMs);

    const onChange = (state) => {
      cleanup();
      resolve(state);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      noble.removeListener("stateChange", onChange);
    };

    noble.on("stateChange", onChange);
  });
}

async function ensureNoblePowered(noble) {
  if (noble.state === "poweredOn") {
    return;
  }
  const state = await waitForNobleState(noble, 5000);
  if (state !== "poweredOn") {
    if (state === "unauthorized") {
      throw new Error("Bluetooth permission denied. Allow Bluetooth access for this process.");
    }
    if (state === "poweredOff") {
      throw new Error("Bluetooth adapter is powered off.");
    }
    if (state === "unsupported") {
      throw new Error("Bluetooth is not supported on this system.");
    }
    throw new Error(`Bluetooth adapter is not powered on (state: ${state}).`);
  }
}

function startNobleScan(noble) {
  return new Promise((resolve, reject) => {
    noble.startScanning([], true, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function stopNobleScan(noble) {
  try {
    noble.stopScanning();
  } catch (err) {
    // Ignore stop scan errors.
  }
}

function getNobleAddress(peripheral) {
  return normalizeAddress(peripheral.id || peripheral.address);
}

function getNobleName(peripheral) {
  return String(peripheral.advertisement && peripheral.advertisement.localName || "").trim();
}

async function scanDevicesNoble(noble, scanMs) {
  await ensureNoblePowered(noble);
  stopNobleScan(noble);
  const found = new Map();

  const onDiscover = (peripheral) => {
    const name = getNobleName(peripheral);
    if (!isBmDeviceName(name)) {
      return;
    }
    const address = getNobleAddress(peripheral);
    if (!address) {
      return;
    }
    found.set(address, {
      address,
      rssi: peripheral.rssi,
      name,
    });
  };

  noble.on("discover", onDiscover);
  try {
    await startNobleScan(noble);
    await wait(scanMs);
  } finally {
    stopNobleScan(noble);
    noble.removeListener("discover", onDiscover);
  }

  return Array.from(found.values());
}

async function findDevicesByAddressNoble(noble, addresses, scanMs) {
  const targetSet = new Set(addresses.map(normalizeAddress).filter(Boolean));
  const found = new Map();

  if (!targetSet.size) {
    return found;
  }

  await ensureNoblePowered(noble);
  stopNobleScan(noble);

  return new Promise((resolve, reject) => {
    const finish = () => {
      stopNobleScan(noble);
      noble.removeListener("discover", onDiscover);
      resolve(found);
    };

    const timeout = setTimeout(() => {
      finish();
    }, scanMs);

    const onDiscover = (peripheral) => {
      const address = getNobleAddress(peripheral);
      if (!address || !targetSet.has(address)) {
        return;
      }
      if (!found.has(address)) {
        found.set(address, peripheral);
      }
      if (found.size === targetSet.size) {
        clearTimeout(timeout);
        finish();
      }
    };

    noble.on("discover", onDiscover);
    startNobleScan(noble).catch((err) => {
      clearTimeout(timeout);
      noble.removeListener("discover", onDiscover);
      reject(err);
    });
  });
}

function encryptCommand(key) {
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const plaintext = Buffer.from(COMMAND_HEX, "hex");
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptPayload(payload, key) {
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString("hex");
}

const BASE_UUID_SUFFIX = "00001000800000805f9b34fb";

function normalizeUuid(uuid) {
  return String(uuid).toLowerCase().replace(/-/g, "");
}

function expandUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) {
    return `0000${normalized}${BASE_UUID_SUFFIX}`;
  }
  if (normalized.length === 8) {
    return `${normalized}${BASE_UUID_SUFFIX}`;
  }
  return normalized;
}

function uuidMatches(candidate, shortUuid) {
  return expandUuid(candidate) === expandUuid(shortUuid);
}

function parseBatteryMessage(messageHex, model) {
  if (!messageHex || messageHex.length < 32) {
    return null;
  }

  if (model === "bm6") {
    if (!messageHex.startsWith("d15507")) {
      return null;
    }
  } else if (model === "bm7") {
    if (!messageHex.startsWith("d1550700")) {
      return null;
    }
  }

  const signByte = messageHex.slice(6, 8);
  if (signByte !== "00" && signByte !== "01") {
    return null;
  }

  const voltage = parseInt(messageHex.slice(15, 18), 16) / 100;
  const soc = parseInt(messageHex.slice(12, 14), 16);
  const tempValue = parseInt(messageHex.slice(8, 10), 16);
  const temperature = signByte === "01" ? -tempValue : tempValue;

  return {
    voltage,
    temperature,
    soc,
  };
}

async function findCharacteristicByUuid(gattServer, shortUuid) {
  const services = await gattServer.services();
  for (const serviceId of services) {
    const service = await gattServer.getPrimaryService(serviceId);
    const characteristics = await service.characteristics();
    const match = characteristics.find((charId) => uuidMatches(charId, shortUuid));
    if (match) {
      return service.getCharacteristic(match);
    }
  }
  return null;
}

async function readBatteryDataBluez(device, model, readTimeoutMs) {
  const key = model === "bm6" ? BM6_KEY : BM7_KEY;
  const command = encryptCommand(key);

  let notifyChar = null;
  try {
    await device.connect();
    const gattServer = await device.gatt();
    const writeChar = await findCharacteristicByUuid(gattServer, WRITE_UUID);
    notifyChar = await findCharacteristicByUuid(gattServer, NOTIFY_UUID);

    if (!writeChar || !notifyChar) {
      throw new Error(`Missing required characteristics on ${model.toUpperCase()}.`);
    }

    const dataPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${model.toUpperCase()} data.`));
      }, readTimeoutMs);

      function onValueChanged(buffer) {
        const messageHex = decryptPayload(buffer, key);
        const parsed = parseBatteryMessage(messageHex, model);
        if (parsed) {
          cleanup();
          resolve(parsed);
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        notifyChar.removeListener("valuechanged", onValueChanged);
      }

      notifyChar.on("valuechanged", onValueChanged);
    });

    await notifyChar.startNotifications();
    await writeChar.writeValueWithResponse(command);
    const data = await dataPromise;
    if (typeof notifyChar.stopNotifications === "function") {
      await notifyChar.stopNotifications();
    }
    return data;
  } finally {
    try {
      await device.disconnect();
    } catch (err) {
      // Ignore disconnect errors.
    }
  }
}

function connectPeripheral(peripheral) {
  return new Promise((resolve, reject) => {
    peripheral.connect((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function disconnectPeripheral(peripheral) {
  return new Promise((resolve) => {
    peripheral.disconnect(() => {
      resolve();
    });
  });
}

function discoverCharacteristics(peripheral) {
  return new Promise((resolve, reject) => {
    peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(characteristics || []);
    });
  });
}

function subscribeCharacteristic(characteristic) {
  return new Promise((resolve, reject) => {
    characteristic.subscribe((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function writeCharacteristic(characteristic, buffer) {
  return new Promise((resolve, reject) => {
    characteristic.write(buffer, false, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function readBatteryDataNoble(peripheral, model, readTimeoutMs) {
  const key = model === "bm6" ? BM6_KEY : BM7_KEY;
  const command = encryptCommand(key);

  let notifyChar = null;
  try {
    await connectPeripheral(peripheral);
    const characteristics = await discoverCharacteristics(peripheral);
    const writeChar = characteristics.find((char) => uuidMatches(char.uuid, WRITE_UUID));
    notifyChar = characteristics.find((char) => uuidMatches(char.uuid, NOTIFY_UUID));

    if (!writeChar || !notifyChar) {
      throw new Error(`Missing required characteristics on ${model.toUpperCase()}.`);
    }

    const dataPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${model.toUpperCase()} data.`));
      }, readTimeoutMs);

      function onData(buffer) {
        const messageHex = decryptPayload(buffer, key);
        const parsed = parseBatteryMessage(messageHex, model);
        if (parsed) {
          cleanup();
          resolve(parsed);
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        notifyChar.removeListener("data", onData);
        if (typeof notifyChar.unsubscribe === "function") {
          notifyChar.unsubscribe(() => {});
        }
      }

      notifyChar.on("data", onData);
      subscribeCharacteristic(notifyChar)
        .then(() => writeCharacteristic(writeChar, command))
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });

    return await dataPromise;
  } finally {
    try {
      await disconnectPeripheral(peripheral);
    } catch (err) {
      // Ignore disconnect errors.
    }
  }
}

function outputScanResults(devices, format) {
  if (format === "json") {
    console.log(JSON.stringify(devices));
    return;
  }

  if (!devices.length) {
    console.log("No BM6 or BM300 Pro devices found.");
    return;
  }

  console.log("Address           RSSI  Name");
  devices.forEach((device) => {
    console.log(`${device.address} ${device.rssi} ${device.name}`);
  });
}

function outputReadResults(results, format) {
  if (format === "json") {
    console.log(JSON.stringify(results));
    return;
  }

  const sections = [
    { label: "BM6", data: results.bm6 },
    { label: "BM7", data: results.bm7 },
  ];

  sections.forEach((section) => {
    const { label, data } = section;
    console.log(`${label} (${data.address})`);
    console.log(`Voltage: ${data.voltage}V`);
    console.log(`Temperature: ${data.temperature}C`);
    console.log(`SoC: ${data.soc}%`);
    console.log("");
  });
}

function outputMappedResults(results, format, timestamp) {
  if (format === "json") {
    console.log(JSON.stringify({ timestamp, devices: results }));
    return;
  }

  console.log(`Readings at ${timestamp}`);
  results.forEach((item) => {
    console.log(`${item.name} (${item.type.toUpperCase()} ${item.address})`);
    console.log(`Voltage: ${item.voltage}V`);
    console.log(`Temperature: ${item.temperature}C`);
    console.log(`SoC: ${item.soc}%`);
    console.log("");
  });
}

function logSocSummary(results, format) {
  if (!Array.isArray(results) || results.length === 0) {
    const message = "Battery percentages: unavailable";
    if (format === "json") {
      console.error(message);
      return;
    }
    console.log(message);
    return;
  }

  const summary = results
    .map((item) => {
      const name = item.name || item.address || "Unknown";
      const soc = typeof item.soc === "number" ? `${item.soc}%` : "n/a";
      return `${name}: ${soc}`;
    })
    .join(", ");
  const message = `Battery percentages: ${summary}`;
  if (format === "json") {
    console.error(message);
    return;
  }
  console.log(message);
}

function askQuestion(rl, prompt, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}: `, (answer) => {
      const trimmed = String(answer || "").trim();
      if (trimmed) {
        resolve(trimmed);
        return;
      }
      resolve(defaultValue || "");
    });
  });
}

function parseBoolean(value, defaultValue) {
  if (value === "") {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

async function createBleClient() {
  if (process.platform === "darwin") {
    return createNobleClient();
  }
  return createBluezClient();
}

async function createBluezClient() {
  const { createBluetooth } = require("node-ble");
  const { bluetooth, destroy } = createBluetooth();
  const adapter = await bluetooth.defaultAdapter();
  return {
    scanDevices: (scanMs) => scanDevicesBluez(adapter, scanMs),
    findDevicesByAddress: (addresses, scanMs) =>
      findDevicesByAddressBluez(adapter, addresses, scanMs),
    readBatteryData: (device, model, readTimeoutMs) =>
      readBatteryDataBluez(device, model, readTimeoutMs),
    destroy,
  };
}

function createNobleClient() {
  let noble;
  try {
    noble = require("@abandonware/noble");
  } catch (err) {
    throw new Error("Missing @abandonware/noble dependency. Run npm install.");
  }

  return {
    scanDevices: (scanMs) => scanDevicesNoble(noble, scanMs),
    findDevicesByAddress: (addresses, scanMs) =>
      findDevicesByAddressNoble(noble, addresses, scanMs),
    readBatteryData: (device, model, readTimeoutMs) =>
      readBatteryDataNoble(device, model, readTimeoutMs),
    destroy: async () => {
      stopNobleScan(noble);
    },
  };
}

async function withBleClient(task) {
  const client = await createBleClient();
  try {
    return await task(client);
  } finally {
    await client.destroy();
  }
}

async function generateConfig(args) {
  let defaults = normalizeConfig({});
  if (fs.existsSync(CONFIG_PATH)) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const overwrite = await askQuestion(rl, "config.json exists. Overwrite? (y/N)", "N");
      if (!parseBoolean(overwrite, false)) {
        console.log("Aborted.");
        return;
      }
    } finally {
      rl.close();
    }
    try {
      defaults = normalizeConfig(readJsonFile(CONFIG_PATH));
    } catch (err) {
      console.log(`Unable to read ${CONFIG_PATH}, using defaults.`);
    }
  }

  const deviceNameByAddress = new Map();
  for (const device of defaults.devices) {
    const address = normalizeAddress(device.address);
    if (!address) {
      continue;
    }
    const name = String(device.name || "").trim();
    if (name) {
      deviceNameByAddress.set(address, name);
    }
  }

  return withBleClient(async (ble) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const devices = await ble.scanDevices(args.scanMs);
      if (!devices.length) {
        throw new Error("No BM6 or BM7 devices found during scan.");
      }

      const deviceEntries = [];
      for (const device of devices) {
        const type = device.name === "BM6" ? "bm6" : "bm7";
        const defaultName =
          deviceNameByAddress.get(normalizeAddress(device.address)) ||
          (device.name === "BM6" ? `BM6 ${device.address}` : `BM7 ${device.address}`);
        const name = await askQuestion(
          rl,
          `Friendly name for ${device.name} (${device.address})`,
          defaultName
        );
        deviceEntries.push({
          name,
          type,
          address: device.address,
        });
      }

      const thresholdInput = await askQuestion(
        rl,
        "Low SoC threshold percentage",
        String(defaults.lowSocThreshold)
      );
      const thresholdValue = Number(thresholdInput);
      const lowSocThreshold = Number.isFinite(thresholdValue)
        ? thresholdValue
        : defaults.lowSocThreshold;

      const userKey = await askQuestion(rl, "Pushover user key", defaults.pushover.userKey);
      const appToken = await askQuestion(rl, "Pushover app token", defaults.pushover.appToken);
      const pushoverEnabled = Boolean(userKey && appToken) && defaults.pushover.enabled;

      const config = {
        schedule: { ...defaults.schedule },
        lowSocThreshold,
        pushover: {
          enabled: pushoverEnabled,
          userKey,
          appToken,
          title: defaults.pushover.title,
        },
        devices: deviceEntries,
      };

      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      console.log(`Wrote ${CONFIG_PATH}`);
    } finally {
      rl.close();
    }
  });
}

function getZonedParts(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const lookup = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  });

  let year = Number(lookup.year);
  let month = Number(lookup.month);
  let day = Number(lookup.day);
  let hour = Number(lookup.hour);
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);

  if (hour === 24) {
    const midnight = new Date(Date.UTC(year, month - 1, day));
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    year = midnight.getUTCFullYear();
    month = midnight.getUTCMonth() + 1;
    day = midnight.getUTCDate();
    hour = 0;
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function makeZonedDate(timeZone, year, month, day, hour, minute, second) {
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = getZonedParts(timeZone, utcDate);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offsetMs = asUtc - utcDate.getTime();
  return new Date(utcDate.getTime() - offsetMs);
}

function getNextRunDate(timeZone, hour, minute) {
  const now = new Date();
  let parts = getZonedParts(timeZone, now);
  let candidate = makeZonedDate(timeZone, parts.year, parts.month, parts.day, hour, minute, 0);

  if (candidate <= now) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    parts = getZonedParts(timeZone, tomorrow);
    candidate = makeZonedDate(timeZone, parts.year, parts.month, parts.day, hour, minute, 0);
  }

  return candidate;
}

function formatZonedTime(timeZone, date) {
  const parts = getZonedParts(timeZone, date);
  const pad2 = (value) => String(value).padStart(2, "0");
  return `${pad2(parts.month)}/${pad2(parts.day)}/${parts.year}, ${pad2(parts.hour)}:${pad2(
    parts.minute
  )}:${pad2(parts.second)}`;
}

function scheduleDailyAt(timeZone, hour, minute, task) {
  const scheduleNext = () => {
    const nextRun = getNextRunDate(timeZone, hour, minute);
    const delayMs = Math.max(0, nextRun.getTime() - Date.now());
    console.log(`Next run at ${formatZonedTime(timeZone, nextRun)} ${timeZone}`);

    setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error(err.message || err);
      }
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();
}

function sendPushover(title, message, pushClient) {
  if (!pushClient) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    pushClient.send(title, message, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}

async function notifyLowSoc(results, config, notification) {
  const low = results.filter(
    (item) => typeof item.soc === "number" && item.soc < config.lowSocThreshold
  );
  if (!low.length) {
    return;
  }

  if (!notification.enabled) {
    return;
  }

  if (!notification.pushClient) {
    console.error("Pushover is not configured; skipping notification.");
    return;
  }

  const lines = low.map((item) => `${item.name}: ${item.soc}% (${item.voltage}V)`);
  const message = lines.join("\n");
  await sendPushover(config.pushover.title, message, notification.pushClient);
}

async function readDeviceMap(ble, mapEntries, args, config, notification) {
  const addresses = mapEntries.map((entry) => entry.address);
  const devices = await ble.findDevicesByAddress(addresses, args.connectScanMs);
  const timestamp = new Date().toISOString();
  const results = [];

  const missingEntries = mapEntries.filter((entry) => {
    const addressKey = normalizeAddress(entry.address);
    return !devices.get(addressKey);
  });

  if (missingEntries.length) {
    const missingList = missingEntries
      .map((entry) => `${entry.name || entry.type.toUpperCase()} (${entry.address})`)
      .join(", ");
    throw new Error(
      `Device not found after ${args.connectScanMs}ms scan: ${missingList}.`
    );
  }

  for (const entry of mapEntries) {
    const addressKey = normalizeAddress(entry.address);
    const device = devices.get(addressKey);
    if (!device) {
      throw new Error(`${entry.type.toUpperCase()} device not found for address ${entry.address}.`);
    }
    const data = await ble.readBatteryData(device, entry.type, args.readTimeoutMs);
    results.push({
      name: entry.name,
      type: entry.type,
      address: entry.address,
      timestamp,
      ...data,
    });
  }

  outputMappedResults(results, args.format, timestamp);
  await notifyLowSoc(results, config, notification);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.format !== "ascii" && args.format !== "json") {
    console.error("Invalid --format value. Use ascii or json.");
    process.exitCode = 1;
    return;
  }

  if (args.scan) {
    await withBleClient(async (ble) => {
      const devices = await ble.scanDevices(args.scanMs);
      outputScanResults(devices, args.format);
    });
    return;
  }

  if (args.generateConfig) {
    await generateConfig(args);
    return;
  }

  if (args.map) {
    const config = normalizeConfig(loadConfigOrThrow());
    if (!config.devices.length) {
      throw new Error("No devices configured. Update config.json or run --generate-config.");
    }
    const notification = buildNotification(config, args);
    const runOnce = async () =>
      await withBleClient(async (ble) =>
        await readDeviceMap(ble, config.devices, args, config, notification)
      );

    if (args.once) {
      await runOnce();
      return;
    }

    if (Number.isFinite(args.intervalHours) && args.intervalHours > 0) {
      const intervalMs = args.intervalHours * 60 * 60 * 1000;
      await runOnce();
      setInterval(() => {
        runOnce().catch((err) => {
          console.error(err.message || err);
        });
      }, intervalMs);
      return;
    }

    scheduleDailyAt(
      config.schedule.timeZone,
      config.schedule.hour,
      config.schedule.minute,
      async () => {
        const results = await runOnce();
        logSocSummary(results, args.format);
      }
    );
    return;
  }

  if (!args.bm6 || !args.bm7) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await withBleClient(async (ble) => {
    const addresses = [args.bm6, args.bm7];
    const devices = await ble.findDevicesByAddress(addresses, args.connectScanMs);

    const bm6Device = devices.get(normalizeAddress(args.bm6));
    const bm7Device = devices.get(normalizeAddress(args.bm7));

    if (!bm6Device) {
      throw new Error(`BM6 device not found for address ${args.bm6}.`);
    }
    if (!bm7Device) {
      throw new Error(`BM7 device not found for address ${args.bm7}.`);
    }

    const bm6Data = await ble.readBatteryData(bm6Device, "bm6", args.readTimeoutMs);
    const bm7Data = await ble.readBatteryData(bm7Device, "bm7", args.readTimeoutMs);

    outputReadResults(
      {
        bm6: { address: args.bm6, ...bm6Data },
        bm7: { address: args.bm7, ...bm7Data },
      },
      args.format
    );
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const REPO_ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config.json");
const CONFIG_TEMPLATE_PATH = path.join(REPO_ROOT, "config.json.default");
const HISTORY_PATH = path.join(REPO_ROOT, "battery_history.json");

const STATIC_DIR = path.join(__dirname, "static");
const CHARTJS_DIST_DIR = path.join(REPO_ROOT, "node_modules", "chart.js", "dist");

function parseArgs(argv) {
  const args = { host: "0.0.0.0", port: 8787 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      args.host = argv[i + 1] || args.host;
      i += 1;
    } else if (arg === "--port") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
        args.port = parsed;
      }
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function normalizeAddress(address) {
  if (!address) {
    return "";
  }
  return String(address).toLowerCase();
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJsonFileAtomic(filePath, obj) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function normalizeConfig(config) {
  const schedule = config && typeof config === "object" ? config.schedule || {} : {};
  const pushover = config && typeof config === "object" ? config.pushover || {} : {};
  const devices = config && typeof config === "object" && Array.isArray(config.devices) ? config.devices : [];

  return {
    schedule: {
      timeZone: typeof schedule.timeZone === "string" && schedule.timeZone.trim() ? schedule.timeZone : "America/Los_Angeles",
      hour: Number.isFinite(schedule.hour) ? schedule.hour : 8,
      minute: Number.isFinite(schedule.minute) ? schedule.minute : 0,
    },
    lowSocThreshold: Number.isFinite(config && config.lowSocThreshold) ? config.lowSocThreshold : 50,
    pushover: {
      enabled: pushover && pushover.enabled !== false,
      userKey: typeof pushover.userKey === "string" ? pushover.userKey : "",
      appToken: typeof pushover.appToken === "string" ? pushover.appToken : "",
      title: typeof pushover.title === "string" && pushover.title.trim() ? pushover.title : "Vehicle Battery Low",
    },
    devices: devices.map((device) => ({
      name: device && typeof device.name === "string" ? device.name : "",
      type: device && (device.type === "bm6" || device.type === "bm7") ? device.type : "bm6",
      address: device && typeof device.address === "string" ? device.address : "",
    })),
  };
}

function normalizeHistory(history) {
  const vehicles =
    history && typeof history === "object" && history.vehicles && typeof history.vehicles === "object"
      ? history.vehicles
      : {};

  const normalizedVehicles = {};
  for (const [key, value] of Object.entries(vehicles)) {
    const addressKey = normalizeAddress(key);
    if (!addressKey) {
      continue;
    }
    const readings = Array.isArray(value && value.readings) ? value.readings : [];
    normalizedVehicles[addressKey] = {
      name: String(value && value.name ? value.name : "").trim(),
      type: value && (value.type === "bm6" || value.type === "bm7") ? value.type : "",
      address: String(value && value.address ? value.address : key),
      readings: readings
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          date: typeof item.date === "string" ? item.date : "",
          timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
          soc: typeof item.soc === "number" ? item.soc : null,
          voltage: typeof item.voltage === "number" ? item.voltage : null,
          temperature: typeof item.temperature === "number" ? item.temperature : null,
        }))
        .filter((item) => item.date || item.timestamp),
    };
  }

  return {
    version: history && typeof history.version === "number" ? history.version : 1,
    updatedAt: history && typeof history.updatedAt === "string" ? history.updatedAt : "",
    vehicles: normalizedVehicles,
  };
}

function loadHistory(filePath) {
  if (!fs.existsSync(filePath)) {
    return normalizeHistory({ version: 1, vehicles: {} });
  }
  try {
    return normalizeHistory(readJsonFile(filePath));
  } catch (err) {
    return normalizeHistory({ version: 1, vehicles: {} });
  }
}

function validateConfigOrThrow(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be a JSON object.");
  }

  const schedule = config.schedule;
  if (!schedule || typeof schedule !== "object") {
    throw new Error("schedule is required.");
  }
  if (typeof schedule.timeZone !== "string" || !schedule.timeZone.trim()) {
    throw new Error("schedule.timeZone must be a non-empty string.");
  }
  if (!Number.isFinite(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
    throw new Error("schedule.hour must be a number from 0 to 23.");
  }
  if (!Number.isFinite(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
    throw new Error("schedule.minute must be a number from 0 to 59.");
  }

  if (!Number.isFinite(config.lowSocThreshold) || config.lowSocThreshold < 0 || config.lowSocThreshold > 100) {
    throw new Error("lowSocThreshold must be a number from 0 to 100.");
  }

  const pushover = config.pushover;
  if (!pushover || typeof pushover !== "object") {
    throw new Error("pushover is required.");
  }
  if (typeof pushover.enabled !== "boolean") {
    throw new Error("pushover.enabled must be boolean.");
  }
  if (typeof pushover.userKey !== "string") {
    throw new Error("pushover.userKey must be a string.");
  }
  if (typeof pushover.appToken !== "string") {
    throw new Error("pushover.appToken must be a string.");
  }
  if (typeof pushover.title !== "string" || !pushover.title.trim()) {
    throw new Error("pushover.title must be a non-empty string.");
  }

  if (!Array.isArray(config.devices)) {
    throw new Error("devices must be an array.");
  }
  for (const device of config.devices) {
    if (!device || typeof device !== "object") {
      throw new Error("Each devices[] entry must be an object.");
    }
    if (typeof device.name !== "string" || !device.name.trim()) {
      throw new Error("Each devices[] entry must have a non-empty name.");
    }
    if (device.type !== "bm6" && device.type !== "bm7") {
      throw new Error("Each devices[] entry type must be 'bm6' or 'bm7'.");
    }
    if (typeof device.address !== "string" || !device.address.trim()) {
      throw new Error("Each devices[] entry must have a non-empty address.");
    }
  }
}

function buildApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    next();
  });

  app.use("/static", express.static(STATIC_DIR, { etag: false, maxAge: 0 }));
  app.use("/vendor/chart.js", express.static(CHARTJS_DIST_DIR, { etag: false, maxAge: 0 }));

  app.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  app.get("/api/config", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!fs.existsSync(CONFIG_PATH)) {
      res.json({ exists: false, path: CONFIG_PATH, config: normalizeConfig({}) });
      return;
    }
    try {
      const config = normalizeConfig(readJsonFile(CONFIG_PATH));
      res.json({ exists: true, path: CONFIG_PATH, config });
    } catch (err) {
      res.status(500).json({ exists: true, path: CONFIG_PATH, error: "Failed to read config.json." });
    }
  });

  app.post("/api/config/init", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (fs.existsSync(CONFIG_PATH)) {
      res.json({ ok: true, existed: true, path: CONFIG_PATH });
      return;
    }
    if (!fs.existsSync(CONFIG_TEMPLATE_PATH)) {
      res.status(500).json({ ok: false, error: "Missing config.json.default template." });
      return;
    }
    fs.copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);
    res.json({ ok: true, existed: false, path: CONFIG_PATH });
  });

  app.put("/api/config", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const config = normalizeConfig(req.body);
      validateConfigOrThrow({
        schedule: {
          timeZone: config.schedule.timeZone,
          hour: config.schedule.hour,
          minute: config.schedule.minute,
        },
        lowSocThreshold: config.lowSocThreshold,
        pushover: {
          enabled: Boolean(config.pushover.enabled),
          userKey: config.pushover.userKey,
          appToken: config.pushover.appToken,
          title: config.pushover.title,
        },
        devices: config.devices,
      });
      writeJsonFileAtomic(CONFIG_PATH, config);
      res.json({ ok: true, path: CONFIG_PATH, config });
    } catch (err) {
      res.status(400).json({ ok: false, error: err && err.message ? err.message : "Invalid config." });
    }
  });

  app.get("/api/history", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!fs.existsSync(HISTORY_PATH)) {
      res.json({ exists: false, path: HISTORY_PATH, history: loadHistory(HISTORY_PATH) });
      return;
    }
    res.json({ exists: true, path: HISTORY_PATH, history: loadHistory(HISTORY_PATH) });
  });

  return app;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node web/server.js [--host 127.0.0.1] [--port 8787]",
      "",
      "Notes:",
      "  By default the server binds to all interfaces (0.0.0.0). This exposes config secrets (Pushover keys) to your LAN.",
      "  Prefer --host 127.0.0.1 and use SSH port-forwarding if you need remote access.",
    ].join("\n")
  );
}

function getLanUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const ifName of Object.keys(nets)) {
    for (const net of nets[ifName] || []) {
      if (!net || net.internal) continue;
      if (net.family === "IPv4" && net.address) {
        urls.push(`http://${net.address}:${port}/`);
      }
      if (net.family === "IPv6" && net.address) {
        urls.push(`http://[${net.address}]:${port}/`);
      }
    }
  }
  return Array.from(new Set(urls)).sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!fs.existsSync(STATIC_DIR)) {
    console.error(`Missing static dir: ${STATIC_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(CHARTJS_DIST_DIR)) {
    console.error(`Missing Chart.js. Run: npm install`);
    process.exit(1);
  }

  const app = buildApp();
  const server = app.listen(args.port, args.host);
  server.on("listening", () => {
    const address = server.address();
    const host = address && typeof address === "object" ? address.address : args.host;
    const port = address && typeof address === "object" ? address.port : args.port;
    if (host && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      console.warn("Warning: binding to a non-localhost interface exposes config secrets (Pushover keys).");
    }
    if (host === "0.0.0.0" || host === "::") {
      console.log(`Web UI listening on ${host}:${port}`);
      const urls = getLanUrls(port);
      if (urls.length) {
        console.log("Open one of:");
        urls.forEach((url) => console.log(`  ${url}`));
      } else {
        console.log(`Open: http://127.0.0.1:${port}/`);
      }
      return;
    }
    console.log(`Web UI running at http://${host}:${port}/`);
  });
  server.on("error", (err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(`Failed to start web server: ${message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

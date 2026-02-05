/* global Chart */
"use strict";

function $(id) {
  return document.getElementById(id);
}

function showToast(message, variant) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("toast--show");
  if (variant === "danger") {
    el.style.borderColor = "rgba(239, 68, 68, 0.45)";
  } else if (variant === "ok") {
    el.style.borderColor = "rgba(34, 197, 94, 0.45)";
  } else {
    el.style.borderColor = "rgba(255,255,255,0.12)";
  }
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => el.classList.remove("toast--show"), 2400);
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status})`);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload && payload.error ? payload.error : `PUT ${path} failed (${res.status})`);
  }
  return payload;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload && payload.error ? payload.error : `POST ${path} failed (${res.status})`);
  }
  return payload;
}

function normalizeAddress(address) {
  return String(address || "").toLowerCase().trim();
}

function parseRangeDays(value) {
  if (value === "all") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return n;
}

function metricLabel(metric) {
  if (metric === "soc") return "SoC (%)";
  if (metric === "temperature") return "Temp (°C)";
  return "Voltage (V)";
}

function metricColor(metric) {
  if (metric === "soc") return "rgba(34, 197, 94, 0.95)";
  if (metric === "temperature") return "rgba(59, 130, 246, 0.95)";
  return "rgba(124, 58, 237, 0.95)";
}

function pickMetricValue(entry, metric) {
  if (metric === "soc") return typeof entry.soc === "number" ? entry.soc : null;
  if (metric === "temperature") return typeof entry.temperature === "number" ? entry.temperature : null;
  return typeof entry.voltage === "number" ? entry.voltage : null;
}

function metricsForSelection(selection) {
  if (selection === "voltage_soc") return ["voltage", "soc"];
  if (selection === "soc") return ["soc"];
  if (selection === "temperature") return ["temperature"];
  return ["voltage"];
}

function formatTimestampLabel(entry) {
  const ts = entry.timestamp || "";
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString();
    }
  }
  return entry.date || "";
}

function filterEntriesByRange(entries, rangeDays) {
  if (!rangeDays) return entries;
  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
    if (Number.isFinite(ts)) return ts >= cutoff;
    // Fallback: try date YYYY-MM-DD
    const d = e.date ? new Date(`${e.date}T12:00:00Z`).getTime() : NaN;
    return Number.isFinite(d) ? d >= cutoff : true;
  });
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function buildDeviceRow(device, onRemove, onChange) {
  const row = document.createElement("div");
  row.className = "deviceRow";

  const nameField = document.createElement("div");
  nameField.className = "field";
  const nameLabel = document.createElement("label");
  nameLabel.className = "field__label";
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = device.name || "";
  nameInput.addEventListener("input", () => {
    device.name = nameInput.value;
    onChange();
  });
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  const typeField = document.createElement("div");
  typeField.className = "field";
  const typeLabel = document.createElement("label");
  typeLabel.className = "field__label";
  typeLabel.textContent = "Type";
  const typeSelect = document.createElement("select");
  const opt6 = document.createElement("option");
  opt6.value = "bm6";
  opt6.textContent = "bm6";
  const opt7 = document.createElement("option");
  opt7.value = "bm7";
  opt7.textContent = "bm7";
  typeSelect.appendChild(opt6);
  typeSelect.appendChild(opt7);
  typeSelect.value = device.type === "bm7" ? "bm7" : "bm6";
  typeSelect.addEventListener("change", () => {
    device.type = typeSelect.value;
    onChange();
  });
  typeField.appendChild(typeLabel);
  typeField.appendChild(typeSelect);

  const addrField = document.createElement("div");
  addrField.className = "field";
  const addrLabel = document.createElement("label");
  addrLabel.className = "field__label";
  addrLabel.textContent = "Address";
  const addrInput = document.createElement("input");
  addrInput.type = "text";
  addrInput.placeholder = "aa:bb:cc:dd:ee:ff or UUID on macOS";
  addrInput.value = device.address || "";
  addrInput.addEventListener("input", () => {
    device.address = addrInput.value;
    onChange();
  });
  addrField.appendChild(addrLabel);
  addrField.appendChild(addrInput);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn btn--danger";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => onRemove());

  row.appendChild(nameField);
  row.appendChild(typeField);
  row.appendChild(addrField);
  row.appendChild(removeBtn);
  return row;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Invalid JSON" };
  }
}

function buildScales(metrics) {
  const base = {
    x: {
      ticks: { maxRotation: 0, autoSkip: true, color: "rgba(255,255,255,0.6)" },
      grid: { color: "rgba(255,255,255,0.08)" },
    },
    y: {
      ticks: { color: "rgba(255,255,255,0.6)" },
      grid: { color: "rgba(255,255,255,0.08)" },
    },
  };

  if (metrics.length === 1) {
    const metric = metrics[0];
    if (metric === "soc") {
      base.y.suggestedMin = 0;
      base.y.suggestedMax = 100;
    }
    return base;
  }

  return {
    ...base,
    y: {
      ...base.y,
      title: { display: true, text: "Voltage (V)", color: "rgba(255,255,255,0.6)" },
    },
    y1: {
      position: "right",
      suggestedMin: 0,
      suggestedMax: 100,
      ticks: { color: "rgba(255,255,255,0.6)" },
      grid: { drawOnChartArea: false },
      title: { display: true, text: "SoC (%)", color: "rgba(255,255,255,0.6)" },
    },
  };
}

function setStatus(text) {
  $("statusText").textContent = text;
}

const state = {
  config: null,
  history: null,
  charts: new Map(), // addressKey -> { chart, canvas }
  timer: null,
  rawDirty: false,
};

function setRawConfigTextFromState() {
  if (!state.config) return;
  if (state.rawDirty) return;
  $("rawConfigText").value = JSON.stringify(state.config, null, 2) + "\n";
}

function renderConfig(config) {
  $("tzInput").value = config.schedule.timeZone || "";
  $("hourInput").value = String(config.schedule.hour ?? 8);
  $("minuteInput").value = String(config.schedule.minute ?? 0);
  $("lowSocInput").value = String(config.lowSocThreshold ?? 50);

  $("pushEnabledInput").checked = Boolean(config.pushover.enabled);
  $("pushTitleInput").value = config.pushover.title || "";
  $("pushUserKeyInput").value = config.pushover.userKey || "";
  $("pushAppTokenInput").value = config.pushover.appToken || "";

  state.rawDirty = false;
  $("rawConfigText").value = JSON.stringify(config, null, 2) + "\n";

  const devicesTable = $("devicesTable");
  devicesTable.innerHTML = "";
  const devices = Array.isArray(config.devices) ? config.devices : [];
  devices.forEach((device, idx) => {
    const row = buildDeviceRow(
      device,
      () => {
      if (state.rawDirty) {
        showToast("Raw JSON has unsaved edits; clear them (or save) before editing devices in the form.", "danger");
        return;
      }
      config.devices.splice(idx, 1);
      renderConfig(config);
      renderCharts();
      },
      () => {
        setRawConfigTextFromState();
        renderCharts();
      }
    );
    devicesTable.appendChild(row);
  });
}

function configFromForm() {
  const schedule = {
    timeZone: $("tzInput").value.trim() || "America/Los_Angeles",
    hour: Number($("hourInput").value),
    minute: Number($("minuteInput").value),
  };
  const pushover = {
    enabled: Boolean($("pushEnabledInput").checked),
    userKey: $("pushUserKeyInput").value || "",
    appToken: $("pushAppTokenInput").value || "",
    title: $("pushTitleInput").value.trim() || "Vehicle Battery Low",
  };
  const devices = (state.config && Array.isArray(state.config.devices) ? state.config.devices : []).map((d) => ({
    name: String(d.name || ""),
    type: d.type === "bm7" ? "bm7" : "bm6",
    address: String(d.address || ""),
  }));

  return {
    schedule,
    lowSocThreshold: Number($("lowSocInput").value),
    pushover,
    devices,
  };
}

function configToSave() {
  if (!state.rawDirty) {
    return state.config ? clone(state.config) : configFromForm();
  }

  const raw = $("rawConfigText").value.trim();
  if (!raw) {
    return state.config ? clone(state.config) : configFromForm();
  }

  const parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    throw new Error(`Raw JSON parse error: ${parsed.error}`);
  }
  return parsed.value;
}

function ensureChartsContainers(devices) {
  const chartsEl = $("charts");
  if (!chartsEl.dataset.inited) {
    chartsEl.className = "chartGrid";
    chartsEl.dataset.inited = "1";
  }

  const existingKeys = new Set();
  devices.forEach((d) => existingKeys.add(normalizeAddress(d.address)));

  for (const key of state.charts.keys()) {
    if (!existingKeys.has(key)) {
      const entry = state.charts.get(key);
      if (entry && entry.wrapper) entry.wrapper.remove();
      state.charts.delete(key);
    }
  }

  devices.forEach((device) => {
    const addressKey = normalizeAddress(device.address);
    if (!addressKey) return;
    if (state.charts.has(addressKey)) return;

    const wrapper = document.createElement("div");
    wrapper.className = "chartCard";

    const head = document.createElement("div");
    head.className = "chartHead";
    const title = document.createElement("div");
    title.className = "chartTitle";
    title.textContent = device.name || device.address || "Unknown";
    const meta = document.createElement("div");
    meta.className = "chartMeta";
    meta.textContent = "";
    head.appendChild(title);
    head.appendChild(meta);

    const body = document.createElement("div");
    body.className = "chartBody";
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    wrapper.appendChild(head);
    body.appendChild(canvas);
    wrapper.appendChild(body);
    chartsEl.appendChild(wrapper);

    state.charts.set(addressKey, { wrapper, canvas, titleEl: title, metaEl: meta, chart: null });
  });
}

function buildSeriesForDevice(addressKey, metrics, rangeDays) {
  const vehicles = state.history && state.history.vehicles ? state.history.vehicles : {};
  const vehicle = vehicles[addressKey];
  const entries = vehicle && Array.isArray(vehicle.readings) ? vehicle.readings : [];
  const filtered = filterEntriesByRange(entries, rangeDays);

  const labels = filtered.map((entry) => formatTimestampLabel(entry));
  const valuesByMetric = {};
  metrics.forEach((metric) => {
    valuesByMetric[metric] = filtered.map((entry) => {
      const value = pickMetricValue(entry, metric);
      return typeof value === "number" ? value : null;
    });
  });

  const latest = entries.length ? entries[entries.length - 1] : null;
  return { labels, valuesByMetric, latest };
}

function buildDatasets(metrics, series) {
  return metrics.map((metric) => {
    const color = metricColor(metric);
    return {
      label: metricLabel(metric),
      data: series.valuesByMetric[metric] || [],
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 1.8,
      pointHoverRadius: 4,
      tension: 0.22,
      yAxisID: metric === "soc" && metrics.length > 1 ? "y1" : "y",
      spanGaps: false,
    };
  });
}

function updateChart(addressKey, device, metric, rangeDays) {
  const slot = state.charts.get(addressKey);
  if (!slot) return;

  slot.titleEl.textContent = device.name || device.address || "Unknown";

  const metrics = metricsForSelection(metric);
  const series = buildSeriesForDevice(addressKey, metrics, rangeDays);
  const datasets = buildDatasets(metrics, series);

  const metaParts = [];
  if (series.latest) {
    const ts = series.latest.timestamp ? new Date(series.latest.timestamp) : null;
    const tsText = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleString() : series.latest.date || "";
    const v = typeof series.latest.voltage === "number" ? `${series.latest.voltage.toFixed(2)}V` : null;
    const s = typeof series.latest.soc === "number" ? `${Math.round(series.latest.soc)}%` : null;
    const t = typeof series.latest.temperature === "number" ? `${series.latest.temperature.toFixed(1)}°C` : null;
    if (v) metaParts.push(v);
    if (s) metaParts.push(s);
    if (t) metaParts.push(t);
    if (tsText) metaParts.push(tsText);
  }
  slot.metaEl.textContent = metaParts.join(" · ");

  if (!slot.chart) {
    const ctx = slot.canvas.getContext("2d");
    slot.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { intersect: false, mode: "index" },
        },
        interaction: { intersect: false, mode: "index" },
        scales: buildScales(metrics),
      },
    });
    return;
  }

  slot.chart.data.labels = series.labels;
  slot.chart.data.datasets = datasets;
  slot.chart.options.scales = buildScales(metrics);
  slot.chart.update("none");
}

function renderCharts() {
  const config = state.config;
  if (!config) return;
  const devices = Array.isArray(config.devices) ? config.devices : [];

  ensureChartsContainers(devices);

  const metric = $("metricSelect").value || "voltage";
  const rangeDays = parseRangeDays($("rangeSelect").value);

  devices.forEach((device) => {
    const addressKey = normalizeAddress(device.address);
    if (!addressKey) return;
    updateChart(addressKey, device, metric, rangeDays);
  });
}

function setAutoRefresh(value) {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
  if (value === "off") return;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  state.timer = window.setInterval(() => refreshAll().catch(() => {}), seconds * 1000);
}

async function refreshAll() {
  try {
    setStatus("Refreshing…");
    const [configRes, historyRes] = await Promise.all([apiGet("/api/config"), apiGet("/api/history")]);

    if (!configRes.exists) {
      await apiPost("/api/config/init");
    }

    const configRes2 = configRes.exists ? configRes : await apiGet("/api/config");
    state.config = clone(configRes2.config);
    state.history = historyRes.history;

    renderConfig(state.config);
    renderCharts();

    const updatedAt = state.history && state.history.updatedAt ? new Date(state.history.updatedAt) : null;
    const updatedText = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toLocaleString() : "n/a";
    setStatus(`History updated: ${updatedText}`);
  } catch (err) {
    console.error(err);
    setStatus("Error loading data");
    showToast(err && err.message ? err.message : "Failed to refresh", "danger");
  }
}

async function saveConfig() {
  try {
    const config = configToSave();
    const payload = await apiPut("/api/config", config);
    state.config = clone(payload.config);
    renderConfig(state.config);
    showToast("Config saved", "ok");
  } catch (err) {
    showToast(err && err.message ? err.message : "Failed to save config", "danger");
  }
}

function wireUi() {
  $("refreshBtn").addEventListener("click", () => refreshAll());
  $("saveBtn").addEventListener("click", () => saveConfig());

  $("metricSelect").addEventListener("change", () => renderCharts());
  $("rangeSelect").addEventListener("change", () => renderCharts());
  $("autoRefreshSelect").addEventListener("change", (e) => setAutoRefresh(e.target.value));

  $("addDeviceBtn").addEventListener("click", () => {
    if (!state.config) return;
    if (state.rawDirty) {
      showToast("Raw JSON has unsaved edits; clear them (or save) before editing devices in the form.", "danger");
      return;
    }
    state.config.devices = Array.isArray(state.config.devices) ? state.config.devices : [];
    state.config.devices.push({ name: "New Vehicle", type: "bm6", address: "" });
    renderConfig(state.config);
    renderCharts();
  });

  $("rawConfigText").addEventListener("input", () => {
    state.rawDirty = true;
  });

  const formInputs = ["tzInput", "hourInput", "minuteInput", "lowSocInput", "pushEnabledInput", "pushTitleInput", "pushUserKeyInput", "pushAppTokenInput"];
  formInputs.forEach((id) => {
    $(id).addEventListener("input", () => {
      if (!state.config) return;
      const newConfig = configFromForm();
      state.config.schedule = newConfig.schedule;
      state.config.lowSocThreshold = newConfig.lowSocThreshold;
      state.config.pushover = newConfig.pushover;
      setRawConfigTextFromState();
    });
  });
}

async function main() {
  wireUi();
  setAutoRefresh($("autoRefreshSelect").value);
  await refreshAll();
}

main().catch((err) => {
  console.error(err);
  showToast(err && err.message ? err.message : "Init failed", "danger");
});

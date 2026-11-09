# Changelog

## 0.1.0 — 2026-11-09

- Replace the Node.js reader and web UI with a native Home Assistant integration
  for BM6 and BM7 / Ancel BM300 Pro battery monitors.
- Use standard ESPHome Bluetooth proxies with automatic routing across monitoring
  areas and preservation of monitor entries when a proxy is replaced.
- Default to one reading attempt every 24 hours, with per-monitor options, persisted
  deadlines, a manual Update now button, and 72-hour stale handling.
- Add voltage, temperature, device-reported charge and battery state, plus polling
  diagnostics and timestamps.
- Include HACS/custom installation instructions, manual-install packaging,
  ESPHome proxy examples, discovery/range troubleshooting, and automated validation.
- Verify live BM6 reads with passive scanning and an external-antenna replacement
  proxy on HA 2026.11. BM7 is implemented and covered by protocol tests; live
  validation with this integration remains pending.

The previous application remains in Git history before this release.

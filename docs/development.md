# Development and releases

## Run the checks

The reproducible integration test environment uses **Python 3.14** and the versions
in `requirements-test.txt`:

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python -m pytest --cov=custom_components.bm_monitor
.venv/bin/ruff check custom_components tests scripts
.venv/bin/ruff format --check custom_components tests scripts
```

Tests use real Home Assistant configuration flows, coordinators, entities, storage,
and Bluetooth routing helpers, with simulated radio hardware. No test connects to
nearby battery monitors. Fixed protocol vectors were independently generated with
Node/OpenSSL, including different keys, negative temperatures, and invalid packets.
These are synthetic fixtures rather than captured hardware packets.

The BLE transport resolves `bleak.BleakClient` at call time. HA installs its wrapper
after loading integrations; retaining an early reference to the native Bleak class
can bypass remote proxies. The routing test exercises HA's real wrapper with two
simulated remote scanners, including fallback when one cannot accept a connection.

Use a separate virtual environment for ESPHome, whose dependencies may differ from
HA's. The example configurations were checked with ESPHome 2026.10.1:

```bash
python3.14 -m venv /tmp/bm-esphome-dev
/tmp/bm-esphome-dev/bin/python -m pip install esphome==2026.10.1
# Add real credentials to esphome/secrets.yaml locally; this file is ignored.
/tmp/bm-esphome-dev/bin/esphome config esphome/battery-proxy.yaml
/tmp/bm-esphome-dev/bin/esphome config esphome/battery-proxy-other-area.yaml
```

CI runs the Python checks, validates both proxy YAML files with dummy credentials,
and runs the official hassfest and HACS validators.

## Hardware acceptance checks

BM6 live readings have been verified on HA 2026.11 using passive scanning, including
replacement of a proxy with an external-antenna model while keeping the monitor
entry. BM7 live validation with this integration is still needed. To test a change:

1. Close the monitor phone app and stop any competing reader.
2. Add a monitor through a nearby proxy and compare measurements with a trusted
   reference. Check Last successful reading, not only the displayed value.
3. Verify Update now in Passive scanning mode.
4. Reload/restart before the next deadline and confirm that it does not force a
   new connection. Let a full scheduled interval elapse to verify automatic reads.
5. Test failure and stale behavior, using shorter intervals if helpful.
6. Verify a second proxy or replacement can read the same monitor entry.

## Publish a release

1. Update `manifest.json` and `CHANGELOG.md` for a new version.
2. Run checks and review the diff, including files that will be removed.
3. Build a manual-install archive:

   ```bash
   .venv/bin/python scripts/package_release.py
   ```

   `dist/bm_monitor.zip` contains `bm_monitor/`, ready to extract into HA's
   `custom_components/`. It excludes generated Python caches and local credentials.
   HACS installs from the repository's standard `custom_components/bm_monitor`
   layout; `zip_release` is intentionally not enabled.
4. Push the commit, verify CI, and publish a GitHub release whose tag matches the
   manifest version (for example `v0.1.0`). Attach `bm_monitor.zip` for manual installs.

Runtime changes are published to GitHub, not automatically copied to the
maintainer's running Home Assistant. Installing/updating on a live HA instance is
a separate operation.

## Protocol layout

Both models write an AES-128-CBC command to characteristic `FFF3` and receive
encrypted notifications on `FFF4`, using a zero IV and model-specific keys.
Real-time frames start with `d15507`. The parser checks the 16-byte block size,
prefix, temperature sign, and percentage range before returning a reading.
Voltage retains the original reader's lower-12-bit centivolt extraction. Unknown
battery-state codes do not discard otherwise valid measurements.

See the [protocol references in the README](../README.md#troubleshooting-development-and-credits).

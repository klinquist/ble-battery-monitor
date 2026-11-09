# BM6 / BM7 Battery Monitor for Home Assistant

<img src="custom_components/bm_monitor/brand/icon.png" alt="Battery monitor icon" width="80" height="80">

Monitor vehicle batteries using **BM6** or **BM7 / Ancel BM300 Pro** Bluetooth
monitors and **ESPHome Bluetooth proxies**. The integration runs in Home Assistant;
an ESP32 near your vehicles relays Bluetooth over your network.

It reads voltage, temperature, the monitor's state-of-charge estimate, and battery
state. Each monitor is polled **once every 24 hours by default**. You can choose a
different interval or request a reading with **Update now**.

## How it works

```text
BM6 / BM7 ── Bluetooth LE ── ESPHome ESP32 proxy ── Wi-Fi/Ethernet ── Home Assistant
```

Home Assistant sends the monitor's commands, decrypts the responses, and creates
sensor entities. The ESP32 runs standard Bluetooth proxy firmware. One or more
proxies can cover different parking areas; HA chooses an available route for each
monitor. You do not select or permanently bind a proxy when adding a battery.

## Features

- BM6 and BM7 / BM300 Pro in one integration, with multiple monitors and proxies.
- Bluetooth discovery, model preselection, and manual entry by MAC address.
- Per-monitor polling, defaulting to 24 hours, without a persistent BLE connection.
- Saved readings and deadlines survive HA restarts, reloads, and proxy replacement.
- One attempt per poll; failed reads wait the full interval before another attempt.
- Configurable stale timeout, defaulting to 72 hours after the last successful read.
- An Update now button and last-success, last-attempt, next-poll, and status sensors.

## Requirements and testing status

- **Home Assistant 2026.10 or newer**.
- An ESPHome Bluetooth proxy with **active GATT connections enabled**, within range
  of the monitor, or a compatible local HA Bluetooth adapter.
- A supported battery monitor. It must be powered from the vehicle battery.

| Monitor | Status |
| --- | --- |
| BM6 | Live reads verified on HA 2026.11, including passive scanning and replacement with an external-antenna proxy |
| BM7 / Ancel BM300 Pro | Implemented and covered by protocol tests; a live test with this integration is still needed |

Automated tests cover both models, scheduling, persistence, entities, configuration
flows, and HA's routing between simulated remote proxies. ESPHome examples validate
with ESPHome 2026.10.1. A proxy's usable range depends on antenna placement, walls,
interference, and the vehicle's metalwork.

## Install

### Option 1: HACS custom repository

1. Install and configure [HACS](https://www.hacs.xyz/docs/use/) if necessary.
2. Open **HACS → ⋮ → Custom repositories**.
3. Add `https://github.com/klinquist/ble-battery-monitor` with type **Integration**.
4. Find **BM6 / BM7 Battery Monitor**, select it, and download the latest release.
5. **Restart Home Assistant**.

This is a HACS custom repository, not a built-in Home Assistant integration or an
entry in the default HACS catalog.

### Option 2: Manual installation

1. Download the [latest release](https://github.com/klinquist/ble-battery-monitor/releases/latest).
   The `bm_monitor.zip` attachment contains a single `bm_monitor` directory.
2. Extract that directory into Home Assistant's `custom_components` folder.
3. Confirm the resulting layout includes:

   ```text
   <HA configuration directory>/
     configuration.yaml
     custom_components/
       bm_monitor/
         __init__.py
         manifest.json
         ...remaining integration files...
         brand/icon.png
         translations/en.json
   ```

4. **Restart Home Assistant**.

The configuration directory is the folder containing `configuration.yaml`. File
editor may display it as **`homeassistant/`**; inside many HA installations it is
also accessible as **`/config`**. Copy the entire integration folder, including
`translations` and `brand`. No `configuration.yaml` entry is required.

## Set up a Bluetooth proxy

Follow the [ESPHome Bluetooth proxy guide](docs/bluetooth-proxy.md) to flash an
ESP32, add it to Home Assistant, and choose scanning settings. It includes the
supplied YAML examples, external antenna advice, and multiple-proxy setup.

**An online device in ESPHome Device Builder must also be added to Home Assistant's
ESPHome integration.** Until then, its Bluetooth radio is not available to HA.

## Add a battery monitor

1. Place the proxy near the vehicle for initial testing. Close the manufacturer's
   app and stop an old reader if either is holding a Bluetooth connection.
2. In HA, open **Settings → Devices & services → Add integration → BM6 / BM7 Battery
   Monitor**. A discovery card may also appear automatically.
3. Select **Choose a discovered BM6 / BM7**, then select the monitor by its MAC
   address. If the list is empty, use the [discovery checklist](docs/troubleshooting.md#no-monitors-appear-in-discovery).
4. Enter a vehicle name. The monitor model is preselected from its advertisement;
   the dropdown is an override. For manual entry, select the correct model yourself.
5. Keep the **24-hour** interval and **72-hour** unavailable timeout, or adjust both.
6. Submit. The integration attempts its first reading immediately.

To enter a device manually, choose **Enter a Bluetooth MAC address** and provide
the physical BLE MAC, such as `AA:BB:CC:DD:EE:FF`. A UUID from macOS CoreBluetooth
is not a BLE MAC address. Manual entry still requires a proxy or adapter to see the
monitor's advertisements.

After any temporary active scanning used for discovery, return the proxy to
**Passive**, then press **Update now** once to verify a fresh reading in that mode.

## Sensors and controls

| Entity | Meaning |
| --- | --- |
| Voltage | Battery voltage in volts |
| Temperature | Monitor temperature, converted to HA's preferred unit |
| State of charge | Percentage reported by the monitor, not a newly calculated curve |
| Battery state | Monitor-reported OK, low voltage, or charging; an unrecognized code is unknown |
| Last successful reading | Timestamp of the most recent valid response |
| Last poll attempt | Timestamp of the most recent attempt, including failures |
| Next scheduled poll | Next automatic attempt, calculated from the last attempt |
| Poll status | OK or failed; attributes include the error and configured intervals |
| Update now | Request one immediate reading and reset this monitor's deadline |

**A displayed measurement may be the last good reading.** Check **Last successful
reading** and **Poll status** to confirm whether an update succeeded.

## Polling and battery use

Each poll opens one short BLE connection, requests the real-time reading, then
disconnects. Opening the discovery list does not connect to monitors, and incoming
advertisements do not cause additional polls. The monitor still performs its own
firmware-controlled advertising and battery use.

- Polling is configurable in each monitor's integration options, in quarter-hour
  increments from 0.25 to 8760 hours.
- Failed reads retain the last good values until their stale timeout; there is no
  automatic rapid retry loop. By default, the next attempt is 24 hours later.
- Values become unavailable after 72 hours without a successful read by default.
  The timeout must be at least as long as the polling interval.
- Restarts and reloads restore the saved deadline. If overdue, HA makes one attempt
  rather than catching up every missed poll.
- Manual updates, successful or failed, reset the deadline. Options changes
  recalculate it from the last attempt; they do not always force a read.

## Multiple proxies, replacements, and updates

Add each proxy to HA's ESPHome integration with a unique device name. Battery
monitors are identified by their own MAC addresses, and HA automatically selects a
reachable proxy. Discovery from two proxies does not create two monitor entries.

To replace an ESP32, register the new proxy, verify **Update now**, then remove the
old ESPHome device. Keep the battery-monitor entry: its entities, history, options,
and saved schedule are retained. A replacement proxy may have a different name.

Update this integration through HACS, or replace its entire directory manually,
then restart HA. Keep the integration entry and its domain `bm_monitor` unchanged.

## Migrating from the old Pi / MQTT reader

This repository now contains the native HA integration and ESPHome examples. The
old Node.js reader and web UI are available in
[Git history](https://github.com/klinquist/ble-battery-monitor/tree/0a6841c2c57d93c1efcabcdc8f4b69dd6ed6f764).

Install the integration and verify each monitor, then retire the old service and
update dashboards and automations to the new HA entities. Existing MQTT entities
and their history are not automatically merged with the new entities. Any Pushover
or low-battery alerts should be implemented as Home Assistant automations.

## Troubleshooting, development, and credits

- [Discovery, connection failures, range, scanning modes, and logs](docs/troubleshooting.md)
- [Development, tests, and release process](docs/development.md)
- [Changelog](CHANGELOG.md)

Protocol work builds on [JeffWDH/bm6-battery-monitor](https://github.com/JeffWDH/bm6-battery-monitor),
[Rafciq/BM6](https://github.com/Rafciq/BM6),
[derekpurdy/BM7](https://github.com/derekpurdy/BM7), and the earlier reader in this
repository. This integration's code is maintained here under the [MIT license](LICENSE).

For the underlying transport, see the official
[HA Bluetooth](https://www.home-assistant.io/integrations/bluetooth/) and
[ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy/) documentation.

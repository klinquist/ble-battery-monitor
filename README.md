# Bluetooth Battery Monitor (BM6/BM7)

I bought a few inexpensive battery monitors from AliExpress and wanted a simple way to check my vehicles' battery health remotely. While there are existing GitHub projects that show how to integrate these devices with ESPHome and Home Assistant, this project keeps things minimal.

It reads battery voltage, temperature, and state of charge from BM6 or BM7 BLE monitors, including the Ancel BM300 Pro, using Node.js and BlueZ. It runs scheduled daily checks and sends a push notification via Pushover when the battery is low.

## Requirements

- Linux with BlueZ (tested on Raspberry Pi/Raspbian).
- Node.js 16+.
- Bluetooth adapter enabled.

## Install

```bash
npm install
```

## Config

Create `config.json` and keep it out of git. A sample file is provided at `config.json.default` (copy it and edit).

```json
{
  "schedule": {
    "timeZone": "America/Los_Angeles",
    "hour": 8,
    "minute": 0
  },
  "lowSocThreshold": 50,
  "pushover": {
    "enabled": true,
    "userKey": "YOUR_PUSHOVER_USER_KEY",
    "appToken": "YOUR_PUSHOVER_APP_TOKEN",
    "title": "Vehicle Battery Low"
  },
  "devices": [
    { "name": "GX460", "type": "bm6", "address": "50:54:7b:5e:81:5e" },
    { "name": "Multistrada", "type": "bm7", "address": "38:3b:26:b3:82:67" }
  ]
}
```

## Generate config interactively

This scans for BM6/BM7 devices, asks for friendly names, low SoC threshold, and Pushover secrets, then writes `config.json`.

```bash
node bm6_bm7.js --generate-config
```

## Usage

Scan for devices:

```bash
node bm6_bm7.js --scan
```

Read configured devices once:

```bash
node bm6_bm7.js --map --once
```

Run daily at the configured time (default 08:00 in config time zone):

```bash
node bm6_bm7.js --map
```

Disable notifications and only print output:

```bash
node bm6_bm7.js --map --once --screen
```

Override schedule with a fixed interval:

```bash
node bm6_bm7.js --map --interval-hours 24
```

Direct read (no config file needed):

```bash
node bm6_bm7.js --bm6 AA:BB:CC:DD:EE:FF --bm7 11:22:33:44:55:66
```

### CLI arguments

- `--scan`: Scan for BM6/BM7 devices.
- `--generate-config`: Create `config.json` interactively.
- `--map`: Use devices defined in `config.json`.
- `--once`: Run one map read and exit.
- `--interval-hours <h>`: Fixed interval override for `--map`.
- `--format ascii|json`: Output format (default: ascii).
- `--scan-ms <ms>`: Scan duration for `--scan` and `--generate-config`.
- `--connect-scan-ms <ms>`: Scan duration when connecting to known addresses.
- `--read-timeout-ms <ms>`: Timeout waiting for a reading.
- `--screen`: Print results only; disable Pushover notifications.
- `--bm6 <addr>` / `--bm7 <addr>`: Direct read of one BM6 and one BM7.

## Raspberry Pi setup (BlueZ + DBus)

### 1) Disable privacy in BlueZ

Edit `/etc/bluetooth/main.conf`:

```
[General]
Privacy = off
```

### 2) Allow DBus access for node-ble

```bash
echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="__USERID__">
   <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>' | sed "s/__USERID__/$(id -un)/" | sudo tee /etc/dbus-1/system.d/node-ble.conf > /dev/null
```

### 3) Restart services

```bash
sudo systemctl restart dbus
sudo systemctl restart bluetooth
```

If Bluetooth fails to start on older kernels, disable the SAP plugin:

```bash
sudo systemctl edit bluetooth
```

```
[Service]
ExecStart=
ExecStart=/usr/lib/bluetooth/bluetoothd --noplugin=sap
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart bluetooth
```

## Run with PM2

```bash
pm2 start bm6_bm7.js --name "BatteryMonitor" -- --map
pm2 save
```

## Troubleshooting

- If you see DBus permission errors, double-check the DBus policy file and restart `dbus` and `bluetooth`.
- If devices are not found, run `--scan` and verify addresses in `config.json`.
- For long-term reliability, keep the process running (PM2 or systemd).

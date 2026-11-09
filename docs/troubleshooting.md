# Troubleshooting

## No monitors appear in discovery

The discovery menu reads advertisements already received by HA. It does not start
a dedicated scan, connect to every nearby device, or ask you to choose a proxy.

1. Confirm the proxy is added and connected under **Settings → Devices & services
   → ESPHome**. Online status in Device Builder alone is insufficient.
2. Confirm the firmware includes `bluetooth_proxy` with **active GATT connections**
   enabled. A listening-only proxy cannot read these monitors.
3. Move the proxy close to the vehicle for the first test. Close the phone app and
   stop the old reader if either is holding a connection.
4. Temporarily select **Active** Bluetooth scanning on the proxy's HA Configure
   screen. Wait about 30 seconds, then reopen the integration's discovery menu.
5. If you know its physical MAC address, use manual entry. The selected model must
   match the device's decryption key.
6. Return to **Passive** scanning after setup and verify Update now succeeds.

Use **Settings → Connectivity → Bluetooth → Advertisements** to inspect what HA
hears, including the reporting adapter/proxy, signal strength, name, and MAC.
Only recognized names appear in the integration's discovery menu. An unnamed device
can still be read by an existing entry once a connectable adapter sees its MAC.

## Update now fails or readings do not change

Check **Poll status**, its `last_error` attribute, **Last poll attempt**, and **Last
successful reading**. Measurement sensors retain the last good reading until the
stale timeout. A visible voltage or percentage is not proof that the latest poll
succeeded. Unchanged measurements with a newer success timestamp are a valid read.

The poll has three bounded phases: connect (20 seconds), subscribe/write/wait for
the response (10 seconds), and disconnect cleanup (5 seconds). A timeout can occur
before any battery data is received. It does not imply a decryption failure.

Check the following:

- Range and obstacles. A monitor inside a vehicle's metal body may need a closer
  proxy or better antenna placement even when other devices are easy to hear.
- The manufacturer's phone app or another BLE reader holding a connection.
- A disconnected proxy or proxy connection slots occupied by other integrations.
- The model option: BM6 and BM7 use different AES keys.
- Whether a replacement proxy has been added to HA and can see this monitor.

Request a deliberate manual retry after resolving the cause. Automatic failures
wait the configured interval; by default they do not retry until 24 hours later.

## Range and external antennas

Test with the proxy close to the vehicle, then move it gradually to the intended
location. RSSI varies, and an advertisement can be audible when the two-way
connection is unreliable. In our live test, an approximately -101 dBm signal timed
out, while a stronger signal allowed a read. Those observations are not universal
RSSI cutoffs or a promise of range.

An external antenna can improve reception and let you place the antenna clear of
obstructions. It does not remove the monitor's own radio limitations. Boards with
Ethernet avoid Wi-Fi sharing the same radio. See the
[hardware and placement guide](bluetooth-proxy.md#choose-and-place-the-hardware).

## Measurements become unavailable

This is expected after the stale timeout, measured from the last successful read.
It defaults to 72 hours. Diagnostics and the Update now button remain usable.
Restore coverage and request a reading to recover the measurement sensors.

If you increase the poll interval, also increase the stale timeout to at least
that interval. A vehicle being away can cause both failed polls and eventual
unavailability without indicating an integration error.

## HA restart or options change

The integration saves the last attempt before contacting the monitor, then saves
the result. A restart or reload restores the deadline. Changing the interval
recalculates the deadline from the last attempt and can make a poll due immediately
if you shorten it. Manual updates reset the deadline even if they fail.

Deleting the battery-monitor entry removes its stored schedule and reading. Keep
that entry when replacing an ESP32 or updating the integration.

## Direct-connection recommendation in HA logs

Some HA Bluetooth versions log a recommendation to use `bleak-retry-connector`
when a connection is requested. This integration deliberately makes one direct
attempt through HA's proxy-aware Bleak client. The helper can retry transient
errors even when configured with one normal attempt, so it is not used here.
That recommendation alone does not mean the connection failed or used the wrong
adapter; check the actual poll result.

## Enable debug logs

Add this to your existing HA logging configuration temporarily, then restart HA:

```yaml
logger:
  default: warning
  logs:
    custom_components.bm_monitor: debug
    homeassistant.components.bluetooth: debug
    habluetooth: debug
```

Turn debug logging off after troubleshooting. Before posting diagnostics publicly,
remove addresses, device names, and other details you do not want to share.

For an [issue report](https://github.com/klinquist/ble-battery-monitor/issues), include
HA/ESPHome versions, monitor model, proxy board and antenna type, whether scanning
was Active or Passive, whether the monitor appears in advertisements, and the poll
error. State whether a close-range test succeeds.

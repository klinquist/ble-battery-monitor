"""Exercise HA's actual Bleak wrapper with two simulated remote scanners."""

from contextlib import ExitStack
from time import monotonic
from unittest.mock import AsyncMock, MagicMock

from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.service import BleakGATTService, BleakGATTServiceCollection
from habluetooth import BaseHaRemoteScanner, HaBluetoothConnector
from homeassistant.components import bluetooth

from custom_components.bm_monitor.bluetooth import async_read_battery
from custom_components.bm_monitor.protocol import NOTIFY_UUID, WRITE_UUID


async def test_real_ha_wrapper_routes_both_areas_and_fails_over(hass, enable_bluetooth):
    factories = []
    scanners = []
    with ExitStack() as stack:
        for source in ("AA:AA:AA:AA:AA:01", "AA:AA:AA:AA:AA:02"):
            backend = MagicMock()
            backend.is_connected = False
            backend.connect = AsyncMock()
            backend.disconnect = AsyncMock()
            backend.start_notify = AsyncMock()
            backend.write_gatt_char = AsyncMock()
            services = BleakGATTServiceCollection()
            service = BleakGATTService(None, 1, "0000fff0-0000-1000-8000-00805f9b34fb")
            services.add_service(service)
            for handle, uuid, properties in (
                (2, WRITE_UUID, ["write"]),
                (3, NOTIFY_UUID, ["notify"]),
            ):
                services.add_characteristic(
                    BleakGATTCharacteristic(None, handle, uuid, properties, lambda: 20, service)
                )
            backend.services = services

            async def connect(*args, backend=backend, **kwargs):
                backend.is_connected = True

            async def disconnect(*args, backend=backend, **kwargs):
                backend.is_connected = False

            async def respond(*args, backend=backend, **kwargs):
                # The write key identifies the requested model.
                command = args[1].hex()
                payload = (
                    "e89b6296cb7a7c0030f1c94a868bfd4d"
                    if command == "697ea0b5d54cf024e794772355554114"
                    else "b29593f83d83152444e9534e00260e18"
                )
                backend.start_notify.call_args.args[1](bytearray.fromhex(payload))

            backend.connect.side_effect = connect
            backend.disconnect.side_effect = disconnect
            backend.write_gatt_char.side_effect = respond
            factory = MagicMock(return_value=backend)
            factories.append(factory)
            scanner = BaseHaRemoteScanner(
                source,
                source,
                connector=HaBluetoothConnector(factory, source, lambda: True),
                connectable=True,
            )
            stack.callback(scanner.async_setup())
            stack.callback(bluetooth.async_register_scanner(hass, scanner, connection_slots=3))
            scanners.append(scanner)

        bm6, bm7 = "BB:BB:BB:BB:BB:01", "BB:BB:BB:BB:BB:02"
        scanners[0]._async_on_advertisement(bm6, -45, "BM6", [], {}, {}, None, {}, monotonic())
        scanners[1]._async_on_advertisement(
            bm7, -45, "BM300 Pro", [], {}, {}, None, {}, monotonic()
        )
        assert (await async_read_battery(hass, bm6, "bm6")).voltage == 11.93
        assert (await async_read_battery(hass, bm7, "bm7")).soc == 76
        assert factories[0].call_count == 1
        assert factories[1].call_count == 1
        assert factories[0].call_args.args[0].details["source"] == scanners[0].source
        assert factories[1].call_args.args[0].details["source"] == scanners[1].source

        # The same BM6 moves into the other area's coverage. HA chooses the new route.
        scanners[1]._async_on_advertisement(bm6, -30, "BM6", [], {}, {}, None, {}, monotonic())
        assert (await async_read_battery(hass, bm6, "bm6")).soc == 76
        assert factories[1].call_count == 2
        assert factories[1].call_args.args[0].details["source"] == scanners[1].source

        # An occupied remote adapter must not block a reachable alternate proxy.
        scanners[1].connector.can_connect = lambda: False
        assert (await async_read_battery(hass, bm6, "bm6")).soc == 76
        assert factories[0].call_count == 2
        assert factories[0].call_args.args[0].details["source"] == scanners[0].source
    await hass.async_block_till_done()

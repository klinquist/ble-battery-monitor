"""Transport tests: single connection, subscription ordering, and cleanup."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bleak import BleakError
from bleak.backends.device import BLEDevice

from custom_components.bm_monitor.bluetooth import BatteryReadError, async_read_battery
from custom_components.bm_monitor.protocol import NOTIFY_UUID, WRITE_UUID


@pytest.fixture
def transport():
    client = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.start_notify = AsyncMock()
    client.write_gatt_char = AsyncMock()
    with (
        patch(
            "custom_components.bm_monitor.bluetooth.bluetooth.async_ble_device_from_address"
        ) as route,
        patch(
            "custom_components.bm_monitor.bluetooth.bleak.BleakClient", return_value=client
        ) as factory,
    ):
        route.return_value = BLEDevice("AA:BB:CC:DD:EE:FF", "BM6", {"source": "garage-proxy"})
        yield client, route, factory


@pytest.mark.parametrize(
    "model,payload",
    [
        ("bm6", "e89b6296cb7a7c0030f1c94a868bfd4d"),
        ("bm7", "b29593f83d83152444e9534e00260e18"),
    ],
)
async def test_subscribe_before_command_and_disconnect(hass, transport, model, payload):
    client, route, factory = transport

    async def immediate_response(*args, **kwargs):
        client.start_notify.assert_awaited_once()
        callback = client.start_notify.call_args.args[1]
        callback(None, bytearray.fromhex(payload))

    client.write_gatt_char.side_effect = immediate_response
    reading = await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", model)
    assert reading.voltage == 11.93
    client.connect.assert_awaited_once()
    client.start_notify.assert_awaited_once_with(NOTIFY_UUID, client.start_notify.call_args.args[1])
    assert client.write_gatt_char.call_args.args[0] == WRITE_UUID
    assert client.write_gatt_char.call_args.kwargs == {"response": True}
    factory.assert_called_once_with(
        route.return_value,
        disconnected_callback=factory.call_args.kwargs["disconnected_callback"],
        timeout=20,
    )
    client.disconnect.assert_awaited_once()


async def test_no_route_means_no_connection_attempt(hass, transport):
    client, route, factory = transport
    route.return_value = None
    with pytest.raises(BatteryReadError, match="No connectable"):
        await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6")
    factory.assert_not_called()
    client.connect.assert_not_awaited()


async def test_connection_failure_has_no_retry_and_releases_slot(hass, transport):
    client, route, factory = transport
    client.connect.side_effect = BleakError("Out of connection slots")
    with pytest.raises(BatteryReadError, match="Out of connection slots"):
        await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6")
    client.connect.assert_awaited_once()
    client.disconnect.assert_awaited_once()


async def test_each_read_resolves_new_proxy_route(hass, transport):
    client, route, factory = transport

    async def response(*args, **kwargs):
        callback = client.start_notify.call_args.args[1]
        callback(None, bytearray.fromhex("e89b6296cb7a7c0030f1c94a868bfd4d"))

    client.write_gatt_char.side_effect = response
    garage = BLEDevice("AA:BB:CC:DD:EE:FF", "BM6", {"source": "garage"})
    other_area = BLEDevice("AA:BB:CC:DD:EE:FF", "BM6", {"source": "other-area"})
    route.side_effect = [garage, other_area]
    await async_read_battery(hass, garage.address, "bm6")
    await async_read_battery(hass, garage.address, "bm6")
    assert [call.args[0] for call in factory.call_args_list] == [garage, other_area]
    assert route.call_count == 2


async def test_invalid_packet_is_ignored_until_valid_response(hass, transport):
    client, _, _ = transport

    async def response(*args, **kwargs):
        callback = client.start_notify.call_args.args[1]
        callback(None, bytearray(b"bad"))
        callback(None, bytearray.fromhex("dd0e909a6fcbab2d9116657ce3624529"))
        callback(None, bytearray.fromhex("e89b6296cb7a7c0030f1c94a868bfd4d"))

    client.write_gatt_char.side_effect = response
    assert (await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6")).soc == 76


async def test_timeout_disconnects(hass, transport):
    client, _, _ = transport
    with patch("custom_components.bm_monitor.bluetooth.READ_TIMEOUT", 0.01):
        with pytest.raises(BatteryReadError, match="timed out"):
            await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6")
    client.disconnect.assert_awaited_once()


async def test_unexpected_disconnect_fails_promptly(hass, transport):
    client, _, factory = transport

    async def disconnect(*args, **kwargs):
        factory.call_args.kwargs["disconnected_callback"](client)

    client.write_gatt_char.side_effect = disconnect
    with pytest.raises(BatteryReadError, match="disconnected"):
        await async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6")
    client.disconnect.assert_awaited_once()


async def test_cancellation_releases_proxy_slot(hass, transport):
    client, _, _ = transport
    started = asyncio.Event()

    async def waiting(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()

    client.start_notify.side_effect = waiting
    task = asyncio.create_task(async_read_battery(hass, "AA:BB:CC:DD:EE:FF", "bm6"))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    client.disconnect.assert_awaited_once()

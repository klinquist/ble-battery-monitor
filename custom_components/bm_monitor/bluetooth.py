"""One short BLE session per poll, using Home Assistant's selected adapter."""

import asyncio
import logging

import bleak
from bleak import BleakError
from homeassistant.components import bluetooth
from homeassistant.core import HomeAssistant

from .const import CONNECT_TIMEOUT, DISCONNECT_TIMEOUT, READ_TIMEOUT
from .protocol import (
    NOTIFY_UUID,
    WRITE_UUID,
    BatteryReading,
    InvalidPacket,
    decode_notification,
    encrypted_read_command,
)

_LOGGER = logging.getLogger(__name__)


class BatteryReadError(Exception):
    """A single poll could not obtain a valid reading."""


async def async_read_battery(hass: HomeAssistant, address: str, model: str) -> BatteryReading:
    """Resolve the current route afresh, including any ESPHome Bluetooth proxy.

    There is deliberately no reconnect loop, active scan, or persistent connection.
    HA wraps BleakClient to use its local or remote BLE backend for this BLEDevice.
    """
    device = bluetooth.async_ble_device_from_address(hass, address, connectable=True)
    if device is None:
        raise BatteryReadError("No connectable Bluetooth adapter/proxy can see this monitor")

    result: asyncio.Future[BatteryReading] = asyncio.get_running_loop().create_future()

    def disconnected(_client: bleak.BleakClient) -> None:
        if not result.done():
            result.set_exception(BatteryReadError("Monitor disconnected before returning data"))

    def notification(_sender: object, data: bytearray) -> None:
        if result.done():
            return
        try:
            reading = decode_notification(bytes(data), model)
        except InvalidPacket as err:
            # Other response types or bad notifications must never become sensor data.
            _LOGGER.debug("Ignoring notification from %s: %s", address, err)
            return
        result.set_result(reading)

    # Resolve the class at call time: HA installs its proxy-aware Bleak wrapper
    # after loading integrations. Importing the class at module load can retain
    # the native-only client and silently bypass all remote adapters.
    client = bleak.BleakClient(device, disconnected_callback=disconnected, timeout=CONNECT_TIMEOUT)
    try:
        async with asyncio.timeout(CONNECT_TIMEOUT):
            await client.connect()
        async with asyncio.timeout(READ_TIMEOUT):
            # Subscribe first so an immediate command response cannot be lost.
            await client.start_notify(NOTIFY_UUID, notification)
            await client.write_gatt_char(WRITE_UUID, encrypted_read_command(model), response=True)
            return await result
    except TimeoutError as err:
        raise BatteryReadError(
            "Bluetooth poll timed out; check range and the selected model"
        ) from err
    except (BleakError, EOFError, OSError) as err:
        raise BatteryReadError(str(err)) from err
    finally:
        # Cancel/consume the future before disconnecting to avoid unhandled exceptions.
        if not result.done():
            result.cancel()
        elif not result.cancelled():
            result.exception()
        # Also try disconnecting after failed/cancelled connects: the backend may
        # have allocated a proxy slot before reporting the failure.
        try:
            async with asyncio.timeout(DISCONNECT_TIMEOUT):
                await client.disconnect()
        except (TimeoutError, BleakError, EOFError, OSError):
            _LOGGER.debug("Unable to cleanly disconnect %s", address, exc_info=True)

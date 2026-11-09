"""Use real HA helpers while preventing contact with Bluetooth hardware."""

from unittest.mock import AsyncMock, PropertyMock, patch

import pytest

from custom_components.bm_monitor.protocol import BatteryReading


@pytest.fixture(autouse=True)
def custom_integrations(enable_custom_integrations):
    """Let HA load the integration from this checkout."""


@pytest.fixture(autouse=True)
def empty_bluetooth_history():
    """The upstream radio fixture simulates Linux, including on macOS hosts."""
    with patch(
        "bluetooth_adapters.systems.linux.LinuxAdapters.history",
        new_callable=PropertyMock,
        return_value={},
    ):
        yield


@pytest.fixture
def read_battery():
    with patch(
        "custom_components.bm_monitor.coordinator.async_read_battery",
        new_callable=AsyncMock,
        return_value=BatteryReading(12.63, 24, 85, "ok"),
    ) as reader:
        yield reader

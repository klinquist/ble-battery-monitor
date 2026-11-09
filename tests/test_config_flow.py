"""HA config flows must be usable without connecting to a battery monitor."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.bm_monitor.const import DOMAIN


@pytest.fixture(autouse=True)
def setup_dependencies(enable_bluetooth):
    """Load HA Bluetooth with the test plugin's mocked radio backend."""


async def start_manual(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == FlowResultType.MENU
    return await hass.config_entries.flow.async_configure(
        result["flow_id"], {"next_step_id": "manual"}
    )


@pytest.mark.parametrize("model", ["bm6", "bm7"])
async def test_manual_defaults_and_no_connection(hass, read_battery, model):
    result = await start_manual(hass)
    assert result["type"] == FlowResultType.FORM
    with patch("custom_components.bm_monitor.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {"address": "aa:bb:cc:dd:ee:ff", "model": model, "name": "Garage car"},
        )
        await hass.async_block_till_done()
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {"address": "AA:BB:CC:DD:EE:FF", "model": model}
    assert result["options"] == {"poll_interval_hours": 24, "stale_after_hours": 72}
    assert result["result"].unique_id == "AA:BB:CC:DD:EE:FF"
    read_battery.assert_not_called()


@pytest.mark.parametrize(
    "data,field,error",
    [
        ({"address": "bad", "model": "bm6"}, "address", "invalid_address"),
        (
            {"address": "AA:BB:CC:DD:EE:FF", "model": "bm7", "poll_interval_hours": 96},
            "stale_after_hours",
            "stale_before_poll",
        ),
    ],
)
async def test_invalid_configuration(hass, data, field, error):
    result = await start_manual(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], data)
    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {field: error}


async def test_discovery_infers_model_without_connecting(hass, read_battery):
    info = SimpleNamespace(name="BM300 Pro", address="AA:BB:CC:DD:EE:FF", connectable=True)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": "bluetooth"}, data=info
    )
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "bluetooth_confirm"
    assert result["data_schema"]({})["model"] == "bm7"
    read_battery.assert_not_called()


async def test_same_monitor_seen_by_second_proxy_does_not_duplicate(hass, read_battery):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="AA:BB:CC:DD:EE:FF",
        data={"address": "AA:BB:CC:DD:EE:FF", "model": "bm6"},
    )
    entry.add_to_hass(hass)
    info = SimpleNamespace(name="BM6", address="aa:bb:cc:dd:ee:ff", connectable=True)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": "bluetooth"}, data=info
    )
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    read_battery.assert_not_called()


async def test_discovered_list_deduplicates_proxies_and_supports_manual_fallback(
    hass, read_battery
):
    infos = [
        SimpleNamespace(name="BM6", address="AA:BB:CC:DD:EE:01"),
        SimpleNamespace(name="BM6", address="AA:BB:CC:DD:EE:01"),
        SimpleNamespace(name="BM300 Pro", address="AA:BB:CC:DD:EE:02"),
    ]
    with patch(
        "custom_components.bm_monitor.config_flow.bluetooth.async_discovered_service_info",
        return_value=infos,
    ):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"next_step_id": "discovered"}
        )
    assert result["type"] == FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"address": "AA:BB:CC:DD:EE:02"}
    )
    assert result["step_id"] == "bluetooth_confirm"
    assert result["data_schema"]({})["model"] == "bm7"
    read_battery.assert_not_called()


async def test_options_validate_expiry_and_keep_custom_frequency(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="AA:BB:CC:DD:EE:FF",
        data={"address": "AA:BB:CC:DD:EE:FF", "model": "bm6"},
        options={"poll_interval_hours": 24, "stale_after_hours": 72},
    )
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"model": "bm7", "poll_interval_hours": 96, "stale_after_hours": 72}
    )
    assert result["errors"] == {"stale_after_hours": "stale_before_poll"}
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"model": "bm7", "poll_interval_hours": 96, "stale_after_hours": 120}
    )
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert entry.options["poll_interval_hours"] == 96
    assert entry.options["model"] == "bm7"

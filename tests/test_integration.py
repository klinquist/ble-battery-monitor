"""Full HA entry/entity lifecycle, with only the BLE read mocked."""

from datetime import timedelta

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.bm_monitor.bluetooth import BatteryReadError
from custom_components.bm_monitor.const import DOMAIN


@pytest.fixture(autouse=True)
def setup_dependencies(enable_bluetooth):
    """Load the real HA Bluetooth integration with simulated radio hardware."""


async def setup_monitor(hass, model="bm6", address="AA:BB:CC:DD:EE:FF", options=None):
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Garage Car",
        unique_id=address,
        data={"address": address, "model": model},
        options=options or {"poll_interval_hours": 24, "stale_after_hours": 72},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    return entry


def entity_id(hass, entry, platform, key):
    return er.async_get(hass).async_get_entity_id(platform, DOMAIN, f"{entry.unique_id}_{key}")


@pytest.mark.parametrize("model", ["bm6", "bm7"])
async def test_entities_manual_button_and_reload(hass, read_battery, model, freezer):
    entry = await setup_monitor(hass, model)
    assert hass.states.get(entity_id(hass, entry, "sensor", "voltage")).state == "12.63"
    assert hass.states.get(entity_id(hass, entry, "sensor", "temperature")).state == "24"
    assert hass.states.get(entity_id(hass, entry, "sensor", "soc")).state == "85"
    assert hass.states.get(entity_id(hass, entry, "sensor", "poll_status")).state == "ok"
    read_battery.assert_awaited_once_with(hass, entry.unique_id, model)
    deadline = entry.runtime_data.data.next_poll(24)
    freezer.tick(timedelta(hours=2))
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.data.next_poll(24) == deadline
    read_battery.assert_awaited_once()
    await hass.services.async_call(
        "button",
        "press",
        {"entity_id": entity_id(hass, entry, "button", "update_now")},
        blocking=True,
    )
    assert read_battery.await_count == 2
    assert entry.runtime_data.data.next_poll(24) == dt_util.utcnow() + timedelta(hours=24)
    coordinator = entry.runtime_data
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert coordinator._shutdown_requested


async def test_options_reload_extends_existing_deadline(hass, read_battery, freezer):
    entry = await setup_monitor(hass)
    attempt = entry.runtime_data.data.last_attempt
    freezer.tick(timedelta(hours=12))
    hass.config_entries.async_update_entry(
        entry, options={"poll_interval_hours": 48, "stale_after_hours": 96}
    )
    await hass.async_block_till_done()
    assert entry.runtime_data.poll_interval == 48
    assert entry.runtime_data.data.next_poll(48) == attempt + timedelta(hours=48)
    read_battery.assert_awaited_once()


async def test_stale_sensor_unavailable_but_diagnostics_and_button_work(
    hass, read_battery, freezer
):
    entry = await setup_monitor(hass, options={"poll_interval_hours": 24, "stale_after_hours": 30})
    success = entry.runtime_data.data.last_success
    read_battery.side_effect = BatteryReadError("Car out of range")
    freezer.move_to(success + timedelta(hours=24))
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, entry, "sensor", "voltage")).state == "12.63"
    freezer.move_to(success + timedelta(hours=30))
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert read_battery.await_count == 2
    assert hass.states.get(entity_id(hass, entry, "sensor", "voltage")).state == "unavailable"
    assert hass.states.get(entity_id(hass, entry, "sensor", "poll_status")).state == "error"
    with pytest.raises(HomeAssistantError, match="Car out of range"):
        await hass.services.async_call(
            "button",
            "press",
            {"entity_id": entity_id(hass, entry, "button", "update_now")},
            blocking=True,
        )
    assert read_battery.await_count == 3
    # A later successful reading recovers the measurement sensors.
    read_battery.side_effect = None
    await hass.services.async_call(
        "button",
        "press",
        {"entity_id": entity_id(hass, entry, "button", "update_now")},
        blocking=True,
    )
    assert hass.states.get(entity_id(hass, entry, "sensor", "voltage")).state == "12.63"


async def test_missing_monitor_loads_with_diagnostics_and_no_automatic_retry(hass, read_battery):
    read_battery.side_effect = BatteryReadError("No proxy can see the monitor")
    entry = await setup_monitor(hass)
    assert hass.states.get(entity_id(hass, entry, "sensor", "voltage")).state == "unavailable"
    assert hass.states.get(entity_id(hass, entry, "sensor", "poll_status")).state == "error"
    assert hass.states.get(entity_id(hass, entry, "button", "update_now")).state != "unavailable"
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    read_battery.assert_awaited_once()


async def test_removing_monitor_cleans_its_storage(hass, read_battery):
    entry = await setup_monitor(hass)
    store = Store(hass, 1, f"{DOMAIN}.{entry.entry_id}")
    assert await store.async_load()
    await hass.config_entries.async_remove(entry.entry_id)
    assert await Store(hass, 1, f"{DOMAIN}.{entry.entry_id}").async_load() is None

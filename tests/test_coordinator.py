"""Verify power-saving behavior with real HA storage/coordinator helpers."""

import asyncio
from dataclasses import replace
from datetime import timedelta

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.bm_monitor.bluetooth import BatteryReadError
from custom_components.bm_monitor.const import DOMAIN
from custom_components.bm_monitor.coordinator import BatteryMonitorCoordinator
from custom_components.bm_monitor.models import MonitorState
from custom_components.bm_monitor.protocol import BatteryReading


def entry_for(hass, address="AA:BB:CC:DD:EE:01", model="bm6", options=None):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=address,
        title=f"Car {address[-2:]}",
        data={"address": address, "model": model},
        options=options or {},
    )
    entry.add_to_hass(hass)
    return entry


async def make_coordinator(hass, entry, lock=None):
    coordinator = BatteryMonitorCoordinator(hass, entry, lock or asyncio.Lock())
    await coordinator.async_initialize()
    return coordinator


async def test_first_read_then_no_reads_before_24_hours(hass, read_battery, freezer):
    coordinator = await make_coordinator(hass, entry_for(hass))
    await coordinator.async_refresh()
    assert coordinator.poll_interval == 24
    assert coordinator.stale_after == 72
    read_battery.assert_awaited_once()
    first = coordinator.data
    for hours in (1, 12, 23.99):
        freezer.move_to(first.last_attempt + timedelta(hours=hours))
        await coordinator.async_refresh()
        assert coordinator.data == first
    read_battery.assert_awaited_once()
    freezer.move_to(first.last_attempt + timedelta(hours=24))
    await coordinator.async_refresh()
    assert read_battery.await_count == 2


async def test_reload_and_restart_restore_deadline_and_reading(hass, read_battery, freezer):
    entry = entry_for(hass)
    original = await make_coordinator(hass, entry)
    await original.async_refresh()
    deadline = original.data.next_poll(24)
    await original.async_shutdown()
    freezer.move_to(original.data.last_attempt + timedelta(hours=12))
    restarted = await make_coordinator(hass, entry)
    await restarted.async_refresh()
    assert restarted.data.reading == original.data.reading
    assert restarted.data.next_poll(24) == deadline
    read_battery.assert_awaited_once()
    freezer.move_to(deadline)
    await restarted.async_refresh()
    assert read_battery.await_count == 2


async def test_failures_use_full_interval_and_keep_last_good_reading(hass, read_battery, freezer):
    entry = entry_for(hass)
    coordinator = await make_coordinator(hass, entry)
    await coordinator.async_refresh()
    good = coordinator.data
    read_battery.side_effect = BatteryReadError("Car is away")
    freezer.move_to(good.last_attempt + timedelta(hours=24))
    await coordinator.async_refresh()
    assert coordinator.data.reading == good.reading
    assert coordinator.data.last_success == good.last_success
    assert coordinator.data.last_error == "Car is away"
    assert coordinator.data.fresh(dt_util.utcnow(), 72)
    await coordinator.async_shutdown()
    freezer.tick(timedelta(hours=1))
    restarted = await make_coordinator(hass, entry)
    await restarted.async_refresh()
    assert read_battery.await_count == 2
    assert restarted.data.last_error == "Car is away"


async def test_failed_initial_read_does_not_require_ha_setup_retry(hass, read_battery, freezer):
    read_battery.side_effect = BatteryReadError("No proxy can see monitor")
    entry = entry_for(hass)
    entry.mock_state(hass, ConfigEntryState.SETUP_IN_PROGRESS)
    coordinator = await make_coordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()
    assert coordinator.last_update_success
    assert coordinator.data.reading is None
    freezer.tick(timedelta(minutes=5))
    await coordinator.async_refresh()
    read_battery.assert_awaited_once()


async def test_manual_read_resets_deadline(hass, read_battery, freezer):
    coordinator = await make_coordinator(hass, entry_for(hass))
    await coordinator.async_refresh()
    freezer.tick(timedelta(hours=2))
    await coordinator.async_poll_now()
    assert read_battery.await_count == 2
    assert coordinator.data.next_poll(24) == dt_util.utcnow() + timedelta(hours=24)
    read_battery.side_effect = BatteryReadError("Out of range")
    with pytest.raises(BatteryReadError, match="Out of range"):
        await coordinator.async_poll_now()
    assert coordinator.data.last_error == "Out of range"


async def test_duplicate_button_presses_share_one_session(hass, read_battery):
    coordinator = await make_coordinator(hass, entry_for(hass))
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_read(*args):
        entered.set()
        await release.wait()
        return BatteryReading(12.7, 20, 95, "ok")

    read_battery.side_effect = slow_read
    first = asyncio.create_task(coordinator.async_poll_now())
    await entered.wait()
    second = asyncio.create_task(coordinator.async_poll_now())
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)
    read_battery.assert_awaited_once()


async def test_custom_interval_and_model_option(hass, read_battery, freezer):
    coordinator = await make_coordinator(
        hass,
        entry_for(
            hass, options={"poll_interval_hours": 48, "stale_after_hours": 96, "model": "bm7"}
        ),
    )
    await coordinator.async_refresh()
    read_battery.assert_awaited_once_with(hass, coordinator.address, "bm7")
    freezer.tick(timedelta(hours=24))
    await coordinator.async_refresh()
    read_battery.assert_awaited_once()
    freezer.tick(timedelta(hours=24))
    await coordinator.async_refresh()
    assert read_battery.await_count == 2


async def test_stale_expiry_is_a_local_update_without_bluetooth(hass, read_battery, freezer):
    coordinator = await make_coordinator(
        hass, entry_for(hass, options={"poll_interval_hours": 24, "stale_after_hours": 30})
    )
    await coordinator.async_refresh()
    success = coordinator.data.last_success
    read_battery.side_effect = BatteryReadError("Out of range")
    freezer.tick(timedelta(hours=24))
    await coordinator.async_refresh()
    assert coordinator.update_interval == timedelta(hours=6)
    freezer.move_to(success + timedelta(hours=30))
    await coordinator.async_refresh()
    assert read_battery.await_count == 2
    assert not coordinator.data.fresh(dt_util.utcnow(), 30)
    assert coordinator.update_interval == timedelta(hours=18)


async def test_attempt_is_saved_before_connect_and_interruption_survives_restart(
    hass, read_battery
):
    entry = entry_for(hass)
    coordinator = await make_coordinator(hass, entry)
    entered = asyncio.Event()

    async def interrupted_read(*args):
        stored = MonitorState.from_dict(await coordinator.store.async_load())
        assert stored.last_attempt is not None
        entered.set()
        await asyncio.Event().wait()

    read_battery.side_effect = interrupted_read
    task = asyncio.create_task(coordinator.async_refresh())
    await entered.wait()
    await coordinator.async_shutdown()
    # HA's coordinator swallows cancellation while finishing an unload.
    await task
    restored = await make_coordinator(hass, entry)
    await restored.async_refresh()
    read_battery.assert_awaited_once()
    assert "interrupted" in restored.data.last_error


async def test_two_monitors_keep_independent_schedules_and_serialize_sessions(hass, read_battery):
    lock = asyncio.Lock()
    first = await make_coordinator(hass, entry_for(hass), lock)
    second = await make_coordinator(hass, entry_for(hass, "AA:BB:CC:DD:EE:02", "bm7"), lock)
    active = 0

    async def read(*args):
        nonlocal active
        active += 1
        assert active == 1
        await asyncio.sleep(0)
        active -= 1
        return BatteryReading(12.5, 22, 80, "ok")

    read_battery.side_effect = read
    await asyncio.gather(first.async_refresh(), second.async_refresh())
    assert read_battery.await_count == 2
    await first.async_refresh()
    await second.async_refresh()
    assert read_battery.await_count == 2


async def test_actual_scheduled_callback_polls_once_at_deadline(hass, read_battery, freezer):
    coordinator = await make_coordinator(hass, entry_for(hass))
    await coordinator.async_refresh()
    unsubscribe = coordinator.async_add_listener(lambda: None)
    deadline = coordinator.data.next_poll(24)
    freezer.move_to(deadline + timedelta(seconds=1))
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done(wait_background_tasks=True)
    assert read_battery.await_count == 2
    unsubscribe()
    await coordinator.async_shutdown()


def test_storage_roundtrip_and_expiry():
    now = dt_util.utcnow()
    state = MonitorState(BatteryReading(12.5, -4, 80, "ok"), now, now)
    assert MonitorState.from_dict(state.to_dict()) == state
    assert state.due(now + timedelta(hours=24), 24)
    assert not state.fresh(now + timedelta(hours=72), 72)
    assert replace(state, last_error="Out of range").fresh(now, 72)

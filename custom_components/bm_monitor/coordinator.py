"""Persisted, battery-conscious scheduling for one monitor."""

import asyncio
import logging
from contextlib import suppress
from dataclasses import replace
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ADDRESS
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .bluetooth import BatteryReadError, async_read_battery
from .const import (
    CONF_MODEL,
    CONF_POLL_INTERVAL,
    CONF_STALE_AFTER,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_STALE_AFTER,
    DOMAIN,
    STORAGE_VERSION,
)
from .models import MonitorState

_LOGGER = logging.getLogger(__name__)


class BatteryMonitorCoordinator(DataUpdateCoordinator[MonitorState]):
    """Schedule the next attempt and stale expiry without polling on advertisements."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, poll_lock: asyncio.Lock) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=entry.title)
        self.entry = entry
        self.address = entry.data[CONF_ADDRESS]
        self.model = entry.options.get(CONF_MODEL, entry.data[CONF_MODEL])
        self.poll_interval = float(entry.options.get(CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL))
        self.stale_after = float(entry.options.get(CONF_STALE_AFTER, DEFAULT_STALE_AFTER))
        self.store: Store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self._state = MonitorState()
        self._poll_lock = poll_lock
        self._poll_task: asyncio.Task[MonitorState] | None = None

    async def async_initialize(self) -> None:
        """Restore before the first refresh, so setup does not force a new read."""
        if stored := await self.store.async_load():
            self._state = MonitorState.from_dict(stored)
        self._update_refresh_interval()

    def _update_refresh_interval(self) -> None:
        """Wake locally at the next poll or expiry; expiry never touches Bluetooth."""
        now = dt_util.utcnow()
        deadline = self._state.next_poll(self.poll_interval) or now
        if self._state.last_success:
            expiry = self._state.last_success + timedelta(hours=self.stale_after)
            if expiry > now:
                deadline = min(deadline, expiry)
        self.update_interval = timedelta(seconds=max(1, (deadline - now).total_seconds()))

    async def _async_update_data(self) -> MonitorState:
        return await self._async_collect(force=False)

    async def async_poll_now(self) -> None:
        """Explicit user action bypasses the deadline and resets the schedule."""
        data = await self._async_collect(force=True)
        self.async_set_updated_data(data)
        if data.last_error:
            raise BatteryReadError(data.last_error)

    async def _async_collect(self, *, force: bool) -> MonitorState:
        if self._shutdown_requested:
            return self._state
        # Coalesce scheduled refreshes and simultaneous button presses.
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = self.hass.async_create_background_task(
                self._async_poll(force=force), f"{DOMAIN} poll {self.address}"
            )
        return await asyncio.shield(self._poll_task)

    async def _async_poll(self, *, force: bool) -> MonitorState:
        async with self._poll_lock:
            now = dt_util.utcnow()
            if not force and not self._state.due(now, self.poll_interval):
                self._update_refresh_interval()
                return self._state
            # Save BEFORE contacting the monitor, so even an interrupted read does
            # not turn every HA restart or integration reload into another wakeup.
            self._state = replace(
                self._state,
                last_attempt=now,
                last_error="The previous poll was interrupted before completion",
            )
            await self.store.async_save(self._state.to_dict())
            try:
                reading = await async_read_battery(self.hass, self.address, self.model)
            except BatteryReadError as err:
                self._state = replace(self._state, last_error=str(err))
                _LOGGER.warning(
                    "%s: %s; next attempt at %s",
                    self.entry.title,
                    err,
                    self._state.next_poll(self.poll_interval),
                )
            else:
                self._state = replace(
                    self._state, reading=reading, last_success=dt_util.utcnow(), last_error=None
                )
            finally:
                self._update_refresh_interval()
            await self.store.async_save(self._state.to_dict())
            return self._state

    async def async_shutdown(self) -> None:
        """Release an in-flight BLE connection on unload or restart."""
        await super().async_shutdown()
        if self._poll_task is not None and not self._poll_task.done():
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task

"""Explicit, user-requested polling."""

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .bluetooth import BatteryReadError
from .coordinator import BatteryMonitorCoordinator
from .entity import BatteryMonitorEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([BatteryMonitorUpdateButton(entry.runtime_data)])


class BatteryMonitorUpdateButton(BatteryMonitorEntity, ButtonEntity):
    """Allow manual testing and updates without waiting for the next deadline."""

    _attr_translation_key = "update_now"
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator: BatteryMonitorCoordinator) -> None:
        super().__init__(coordinator, "update_now")

    @property
    def available(self) -> bool:
        # The button must remain usable when a scheduled read fails.
        return not self.coordinator._shutdown_requested

    async def async_press(self) -> None:
        try:
            await self.coordinator.async_poll_now()
        except BatteryReadError as err:
            raise HomeAssistantError(str(err)) from err

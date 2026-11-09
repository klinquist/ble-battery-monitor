"""Shared device identity for sensors and buttons."""

from homeassistant.helpers.device_registry import CONNECTION_BLUETOOTH, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MODELS
from .coordinator import BatteryMonitorCoordinator


class BatteryMonitorEntity(CoordinatorEntity[BatteryMonitorCoordinator]):
    """An entity belonging to one monitor, independent of its current proxy."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: BatteryMonitorCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.address}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.address)},
            connections={(CONNECTION_BLUETOOTH, coordinator.address)},
            name=coordinator.entry.title,
            model=MODELS[coordinator.model],
        )

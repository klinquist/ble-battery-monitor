"""Battery measurements and scheduling diagnostics."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    EntityCategory,
    UnitOfElectricPotential,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import BatteryMonitorCoordinator
from .entity import BatteryMonitorEntity


@dataclass(frozen=True, kw_only=True)
class BatterySensorDescription(SensorEntityDescription):
    """Measurement fields become unavailable when the reading expires."""

    measurement: bool = False


SENSORS = (
    BatterySensorDescription(
        key="voltage",
        translation_key="voltage",
        measurement=True,
        device_class=SensorDeviceClass.VOLTAGE,
        native_unit_of_measurement=UnitOfElectricPotential.VOLT,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
    ),
    BatterySensorDescription(
        key="temperature",
        translation_key="temperature",
        measurement=True,
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    BatterySensorDescription(
        key="soc",
        translation_key="soc",
        measurement=True,
        device_class=SensorDeviceClass.BATTERY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    BatterySensorDescription(
        key="state",
        translation_key="state",
        measurement=True,
        device_class=SensorDeviceClass.ENUM,
        options=["ok", "low_voltage", "charging"],
    ),
    BatterySensorDescription(
        key="last_success",
        translation_key="last_success",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    BatterySensorDescription(
        key="last_attempt",
        translation_key="last_attempt",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    BatterySensorDescription(
        key="next_poll",
        translation_key="next_poll",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    BatterySensorDescription(
        key="poll_status",
        translation_key="poll_status",
        device_class=SensorDeviceClass.ENUM,
        options=["never_read", "ok", "error"],
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities(
        BatteryMonitorSensor(entry.runtime_data, description) for description in SENSORS
    )


class BatteryMonitorSensor(BatteryMonitorEntity, SensorEntity):
    """A value from the monitor or its persisted polling state."""

    entity_description: BatterySensorDescription

    def __init__(
        self, coordinator: BatteryMonitorCoordinator, description: BatterySensorDescription
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def available(self) -> bool:
        if not super().available:
            return False
        return not self.entity_description.measurement or self.coordinator.data.fresh(
            dt_util.utcnow(), self.coordinator.stale_after
        )

    @property
    def native_value(self) -> float | int | str | datetime | None:
        state = self.coordinator.data
        key = self.entity_description.key
        if self.entity_description.measurement:
            return getattr(state.reading, key) if state.reading else None
        if key == "next_poll":
            return state.next_poll(self.coordinator.poll_interval)
        if key == "poll_status":
            return "error" if state.last_error else "ok" if state.last_success else "never_read"
        return getattr(state, key)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self.entity_description.key != "poll_status":
            return None
        return {
            "last_error": self.coordinator.data.last_error,
            "poll_interval_hours": self.coordinator.poll_interval,
            "stale_after_hours": self.coordinator.stale_after,
        }

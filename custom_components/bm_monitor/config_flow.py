"""Discover or manually configure a monitor without probing it over GATT."""

from typing import Any

import probatio as vol
from homeassistant.components import bluetooth
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_ADDRESS, CONF_NAME
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import selector

from .const import (
    CONF_MODEL,
    CONF_POLL_INTERVAL,
    CONF_STALE_AFTER,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_STALE_AFTER,
    DOMAIN,
    MAX_POLL_INTERVAL,
    MIN_POLL_INTERVAL,
    MODELS,
    model_from_name,
)


def _settings_schema(defaults: dict[str, Any]) -> dict:
    """Settings use hours to make the low-frequency polling intent explicit."""
    return {
        vol.Required(CONF_MODEL, default=defaults.get(CONF_MODEL, "bm6")): vol.In(MODELS),
        vol.Required(
            CONF_POLL_INTERVAL, default=defaults.get(CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL)
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=MIN_POLL_INTERVAL,
                max=MAX_POLL_INTERVAL,
                step=0.25,
                mode=selector.NumberSelectorMode.BOX,
                unit_of_measurement="h",
            )
        ),
        vol.Required(
            CONF_STALE_AFTER, default=defaults.get(CONF_STALE_AFTER, DEFAULT_STALE_AFTER)
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=MIN_POLL_INTERVAL,
                max=87600,
                step=0.25,
                mode=selector.NumberSelectorMode.BOX,
                unit_of_measurement="h",
            )
        ),
    }


def _validate_settings(user_input: dict[str, Any]) -> dict[str, str]:
    if user_input[CONF_STALE_AFTER] < user_input[CONF_POLL_INTERVAL]:
        return {CONF_STALE_AFTER: "stale_before_poll"}
    return {}


class BatteryMonitorConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configure one monitor; both proxies may discover the same unique address."""

    VERSION = 1

    def __init__(self) -> None:
        self._address: str | None = None
        self._model = "bm6"
        self._discovered: dict[str, str] = {}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> "BatteryMonitorOptionsFlow":
        return BatteryMonitorOptionsFlow()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(step_id="user", menu_options=["discovered", "manual"])

    async def async_step_discovered(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            self._address = user_input[CONF_ADDRESS]
            self._model = self._discovered[self._address]
            await self.async_set_unique_id(self._address)
            self._abort_if_unique_id_configured()
            return await self.async_step_bluetooth_confirm()
        existing = self._async_current_ids()
        self._discovered = {
            info.address.upper(): model
            for info in bluetooth.async_discovered_service_info(self.hass, connectable=True)
            if (model := model_from_name(info.name)) and info.address.upper() not in existing
        }
        if not self._discovered:
            return self.async_abort(reason="no_devices_found")
        return self.async_show_form(
            step_id="discovered",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ADDRESS): vol.In(
                        {
                            address: f"{MODELS[model]} ({address})"
                            for address, model in self._discovered.items()
                        }
                    )
                }
            ),
        )

    async def async_step_bluetooth(
        self, discovery_info: bluetooth.BluetoothServiceInfoBleak
    ) -> ConfigFlowResult:
        model = model_from_name(discovery_info.name)
        if model is None or not discovery_info.connectable:
            return self.async_abort(reason="unsupported_device")
        self._address = discovery_info.address.upper()
        self._model = model
        await self.async_set_unique_id(self._address)
        self._abort_if_unique_id_configured()
        self.context["title_placeholders"] = {"name": f"{MODELS[model]} ({self._address})"}
        return await self.async_step_bluetooth_confirm()

    async def async_step_bluetooth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._async_configure("bluetooth_confirm", user_input)

    async def async_step_manual(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._async_configure("manual", user_input)

    async def _async_configure(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        errors = {}
        if user_input is not None:
            errors = _validate_settings(user_input)
            if step_id == "manual":
                try:
                    self._address = cv.matches_regex(r"^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")(
                        user_input[CONF_ADDRESS].strip()
                    ).upper()
                except vol.Invalid:
                    errors[CONF_ADDRESS] = "invalid_address"
            if not errors:
                assert self._address is not None
                await self.async_set_unique_id(self._address)
                self._abort_if_unique_id_configured()
                name = (
                    user_input.get(CONF_NAME, "").strip()
                    or f"{MODELS[user_input[CONF_MODEL]]} {self._address[-5:]}"
                )
                return self.async_create_entry(
                    title=name,
                    data={CONF_ADDRESS: self._address, CONF_MODEL: user_input[CONF_MODEL]},
                    options={
                        CONF_POLL_INTERVAL: user_input[CONF_POLL_INTERVAL],
                        CONF_STALE_AFTER: user_input[CONF_STALE_AFTER],
                    },
                )
        defaults = {CONF_MODEL: self._model, **(user_input or {})}
        fields = {}
        if step_id == "manual":
            fields[vol.Required(CONF_ADDRESS, default=defaults.get(CONF_ADDRESS, ""))] = str
        fields[vol.Optional(CONF_NAME, default=defaults.get(CONF_NAME, ""))] = str
        fields.update(_settings_schema(defaults))
        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema(fields),
            errors=errors,
            description_placeholders={"address": self._address or ""},
        )


class BatteryMonitorOptionsFlow(OptionsFlow):
    """Change frequency without resetting the last-attempt timestamp."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors = _validate_settings(user_input) if user_input is not None else {}
        if user_input is not None and not errors:
            return self.async_create_entry(title="", data=user_input)
        defaults = {
            CONF_MODEL: self.config_entry.data[CONF_MODEL],
            **self.config_entry.options,
            **(user_input or {}),
        }
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema(_settings_schema(defaults)), errors=errors
        )

"""Configuration shared by the BM6/BM7 integration."""

DOMAIN = "bm_monitor"
CONF_MODEL = "model"
CONF_POLL_INTERVAL = "poll_interval_hours"
CONF_STALE_AFTER = "stale_after_hours"
DEFAULT_POLL_INTERVAL = 24.0
DEFAULT_STALE_AFTER = 72.0
MIN_POLL_INTERVAL = 0.25
MAX_POLL_INTERVAL = 8760.0
MODELS = {"bm6": "BM6", "bm7": "BM7 / BM300 Pro"}
CONNECT_TIMEOUT = 20
READ_TIMEOUT = 10
DISCONNECT_TIMEOUT = 5
STORAGE_VERSION = 1


def model_from_name(name: str | None) -> str | None:
    """Identify known advertisement names without connecting to a monitor."""
    if name == "BM6":
        return "bm6"
    if name in ("BM7", "BM300 Pro"):
        return "bm7"
    return None

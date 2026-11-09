"""Persistent readings and scheduling, without Home Assistant dependencies."""

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any

from .protocol import BatteryReading


def _timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("Stored timestamps must have a time zone")
    return result


@dataclass(frozen=True)
class MonitorState:
    """Last attempt is persisted even when a reading fails or HA is interrupted."""

    reading: BatteryReading | None = None
    last_attempt: datetime | None = None
    last_success: datetime | None = None
    last_error: str | None = None

    def next_poll(self, interval_hours: float) -> datetime | None:
        """Return the next deadline, shared by successful and failed attempts."""
        if self.last_attempt is None:
            return None
        return self.last_attempt + timedelta(hours=interval_hours)

    def due(self, now: datetime, interval_hours: float) -> bool:
        """An advertisement, reload, or restart must not bypass the deadline."""
        deadline = self.next_poll(interval_hours)
        return deadline is None or now >= deadline

    def fresh(self, now: datetime, stale_hours: float) -> bool:
        """A failed poll may retain a reading until its configured expiry."""
        return (
            self.reading is not None
            and self.last_success is not None
            and now < self.last_success + timedelta(hours=stale_hours)
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize through Home Assistant's storage helper."""
        return {
            "reading": asdict(self.reading) if self.reading else None,
            "last_attempt": self.last_attempt.isoformat() if self.last_attempt else None,
            "last_success": self.last_success.isoformat() if self.last_success else None,
            "last_error": self.last_error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MonitorState":
        """Restore the schedule and readings together."""
        return cls(
            reading=BatteryReading(**data["reading"]) if data.get("reading") else None,
            last_attempt=_timestamp(data.get("last_attempt")),
            last_success=_timestamp(data.get("last_success")),
            last_error=data.get("last_error"),
        )

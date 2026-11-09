"""BM6/BM7 wire protocol, independent of Bluetooth and Home Assistant.

Protocol references and acknowledgements are in README.md.
"""

from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

WRITE_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"
READ_COMMAND = bytes.fromhex("d1550700000000000000000000000000")
KEYS = {
    "bm6": bytes([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 57]),
    "bm7": bytes([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 64]),
}
STATES = {0: "ok", 1: "low_voltage", 2: "charging"}


class InvalidPacket(ValueError):
    """A notification is not a valid real-time battery reading."""


@dataclass(frozen=True)
class BatteryReading:
    """Values reported by the battery monitor, without calculated SoC."""

    voltage: float
    temperature: int
    soc: int
    state: str | None


def _cipher(model: str) -> Cipher:
    """Build a fresh AES-CBC cipher with the protocol's zero IV."""
    if model not in KEYS:
        raise ValueError(f"Unsupported battery monitor model: {model}")
    return Cipher(algorithms.AES(KEYS[model]), modes.CBC(bytes(16)))


def encrypted_read_command(model: str) -> bytes:
    """Encrypt exactly one command block, without padding."""
    encryptor = _cipher(model).encryptor()
    return encryptor.update(READ_COMMAND) + encryptor.finalize()


def decode_notification(payload: bytes, model: str) -> BatteryReading:
    """Decrypt one real-time block and validate it before publishing sensors."""
    if len(payload) != 16:
        raise InvalidPacket("Expected a 16-byte notification")
    decryptor = _cipher(model).decryptor()
    data = decryptor.update(payload) + decryptor.finalize()
    if data[:3] != READ_COMMAND[:3]:
        raise InvalidPacket("Unexpected response prefix; check the selected model")
    if data[3] not in (0, 1):
        raise InvalidPacket("Invalid temperature sign")
    if data[6] > 100:
        raise InvalidPacket("Invalid state of charge")
    return BatteryReading(
        # Preserve the working reader's three-hex-digit voltage extraction.
        voltage=(int.from_bytes(data[7:9], "big") & 0x0FFF) / 100,
        temperature=-data[4] if data[3] else data[4],
        soc=data[6],
        state=STATES.get(data[5]),
    )

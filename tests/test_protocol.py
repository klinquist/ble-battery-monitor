"""Independent fixed vectors generated with Node/OpenSSL, not this decoder."""

import pytest

from custom_components.bm_monitor.protocol import (
    BatteryReading,
    InvalidPacket,
    decode_notification,
    encrypted_read_command,
)

VECTORS = {
    "bm6": {
        "command": "697ea0b5d54cf024e794772355554114",
        "warm": "e89b6296cb7a7c0030f1c94a868bfd4d",
        "upper_nibble": "a5350e7414b3aed8e1b9a1bc62745fb8",
        "cold": "20ff5a5d6d1acbaff184c0f56e52fb0b",
        "bad_soc": "d4eb29682e87828f1aeede79888e4d2a",
        "bad_sign": "64973c68b94760e269ee06849020deb1",
        "version": "dd0e909a6fcbab2d9116657ce3624529",
    },
    "bm7": {
        "command": "586d7b2377c6924dcd750acb29f5bf8d",
        "warm": "b29593f83d83152444e9534e00260e18",
        "upper_nibble": "132fdab9219f5c68098cf979f5333f30",
        "cold": "bb8fc97e64bc04655a2a62270d123ccd",
        "bad_soc": "3932c0041b4ccb62d1e347cfc4bdd0df",
        "bad_sign": "a0e28649128abd2555d8992ba5fd22ac",
        "version": "25ffbd459b66906df89f25beb41e5c84",
    },
}


@pytest.mark.parametrize("model", VECTORS)
def test_command(model):
    assert encrypted_read_command(model).hex() == VECTORS[model]["command"]


@pytest.mark.parametrize("model", VECTORS)
@pytest.mark.parametrize(
    "condition,expected",
    [
        ("warm", BatteryReading(11.93, 24, 76, "ok")),
        ("cold", BatteryReading(10, -5, 50, "low_voltage")),
    ],
)
def test_decode(model, condition, expected):
    assert decode_notification(bytes.fromhex(VECTORS[model][condition]), model) == expected


@pytest.mark.parametrize("model", VECTORS)
@pytest.mark.parametrize("condition", ["bad_soc", "bad_sign", "version"])
def test_reject_invalid_readings(model, condition):
    with pytest.raises(InvalidPacket):
        decode_notification(bytes.fromhex(VECTORS[model][condition]), model)


@pytest.mark.parametrize("payload", [b"", b"x" * 15, b"x" * 17, b"x" * 32])
def test_reject_invalid_length(payload):
    with pytest.raises(InvalidPacket):
        decode_notification(payload, "bm6")


def test_wrong_key_cannot_publish_garbage():
    with pytest.raises(InvalidPacket):
        decode_notification(bytes.fromhex(VECTORS["bm7"]["warm"]), "bm6")


@pytest.mark.parametrize("model", VECTORS)
def test_voltage_extraction_matches_working_node_reader(model):
    assert (
        decode_notification(bytes.fromhex(VECTORS[model]["upper_nibble"]), model).voltage == 11.93
    )


def test_unknown_model():
    with pytest.raises(ValueError, match="Unsupported"):
        encrypted_read_command("bm2")

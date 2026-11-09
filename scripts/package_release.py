"""Build the manual-install ZIP without including local/generated files."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "custom_components" / "bm_monitor"


def build_archive(destination: Path) -> None:
    """Keep the bm_monitor directory, for extraction into custom_components."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
        for path in sorted(INTEGRATION.rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            if path.suffix not in {".py", ".json", ".png", ".svg"}:
                continue
            archive.write(path, Path("bm_monitor") / path.relative_to(INTEGRATION))
        archive.write(ROOT / "LICENSE", "bm_monitor/LICENSE")
    with ZipFile(destination) as archive:
        if bad_file := archive.testzip():
            raise RuntimeError(f"Corrupt archive member: {bad_file}")
        manifest = json.loads(archive.read("bm_monitor/manifest.json"))
        print(
            f"Built {destination.name}: version {manifest['version']}, "
            f"{len(archive.namelist())} files"
        )


if __name__ == "__main__":
    build_archive(ROOT / "dist" / "bm_monitor.zip")

import hashlib
import io
import json
import tarfile
import zipfile

import pytest
from scripts.restore_models import restore_models


@pytest.mark.parametrize("kind", ["zip", "tar", "portable-zip"])
def test_only_reviewed_assets_are_restored_and_bundle_manifest_is_ignored(tmp_path, kind):
    payload = b"reviewed model bytes"
    manifest = tmp_path / "trusted.json"
    manifest.write_text(
        json.dumps(
            {
                "assets": {
                    "species/model.bin": {
                        "size": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                }
            }
        )
    )
    archive = tmp_path / f"bundle.{kind}"
    prefix = "resources/models/" if kind == "portable-zip" else "engine/models/"
    entries = {
        prefix + "species/model.bin": payload,
        prefix + "manifest.json": b"untrusted",
        "../outside.txt": b"do not extract",
    }
    if kind.endswith("zip"):
        with zipfile.ZipFile(archive, "w") as output:
            for name, content in entries.items():
                output.writestr(name, content)
    else:
        with tarfile.open(archive, "w") as output:
            for name, content in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                output.addfile(info, io.BytesIO(content))
    models = tmp_path / "models"
    assert restore_models(archive, models, manifest) == 1
    assert (models / "species/model.bin").read_bytes() == payload
    assert (models / "manifest.json").read_bytes() == manifest.read_bytes()
    assert not (tmp_path / "outside.txt").exists()


def test_invalid_model_does_not_replace_an_existing_valid_file(tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    (models / "model.bin").write_bytes(b"original")
    manifest = tmp_path / "trusted.json"
    manifest.write_text(
        json.dumps(
            {
                "assets": {
                    "model.bin": {"size": 8, "sha256": hashlib.sha256(b"original").hexdigest()}
                }
            }
        )
    )
    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("model.bin", b"modified")
    with pytest.raises(ValueError, match="mismatch"):
        restore_models(archive, models, manifest)
    assert (models / "model.bin").read_bytes() == b"original"
    assert not list(models.glob("*.download"))

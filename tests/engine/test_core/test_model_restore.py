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


@pytest.mark.parametrize("checkout_payload", [b"reviewed metadata", b"modified", None])
def test_release_bundle_uses_only_verified_checkout_assets(tmp_path, checkout_payload):
    models = tmp_path / "models"
    models.mkdir()
    payloads = {"model.bin": b"reviewed weights", "config.json": b"reviewed metadata"}
    manifest = tmp_path / "trusted.json"
    manifest.write_text(
        json.dumps(
            {
                "assets": {
                    name: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    for name, data in payloads.items()
                }
            }
        )
    )
    if checkout_payload is not None:
        (models / "config.json").write_bytes(checkout_payload)
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        info = tarfile.TarInfo("models/model.bin")
        info.size = len(payloads["model.bin"])
        output.addfile(info, io.BytesIO(payloads["model.bin"]))
    if checkout_payload == payloads["config.json"]:
        assert restore_models(archive, models, manifest) == 2
        assert (models / "model.bin").read_bytes() == payloads["model.bin"]
        assert (models / "config.json").read_bytes() == checkout_payload
    else:
        with pytest.raises(ValueError, match="missing reviewed asset|Checkout model SHA-256"):
            restore_models(archive, models, manifest)
        assert not (models / "model.bin").exists()

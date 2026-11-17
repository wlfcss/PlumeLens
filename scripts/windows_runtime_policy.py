"""Files needed by the Windows inference runtime, excluding SDK build tools."""

from pathlib import PurePosixPath


def include_rocm_runtime_file(relative_path: str) -> bool:
    path = PurePosixPath(relative_path.replace("\\", "/"))
    if "aotriton.images" in path.parts:
        # Windows DINOv3 uses eager FP32 attention, so these archived flash
        # kernels are unused. The linked AOTriton runtime DLLs remain included.
        return False
    # Keep runtime DLLs, device kernels, headers/resources used by HIP RTC,
    # package metadata and licenses. PlumeLens does not build custom HIP code.
    return not ("_rocm_sdk_core" in path.parts and path.suffix.lower() in {".exe", ".lib", ".pdb"})

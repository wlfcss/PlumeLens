from scripts.windows_runtime_policy import include_rocm_runtime_file


def test_preserves_gpu_runtime_and_device_kernels():
    for path in (
        "_rocm_sdk_core/bin/amd_comgr.dll",
        "_rocm_sdk_core/bin/hiprtc0700.dll",
        "_rocm_sdk_core/lib/llvm/bin/libclang.dll",
        "_rocm_sdk_core/include/hip/hip_runtime.h",
        "_rocm_sdk_libraries/.kpack/blas_lib_gfx1100.kpack",
        "torch/.kpack/torch_gfx1100.kpack",
        "_rocm_sdk_core/share/LICENSE.txt",
        "torch/lib/aotriton_v2.dll",
        "rocm_sdk_core-7.14.1.dist-info/METADATA",
        "plumelens-engine.exe",
    ):
        assert include_rocm_runtime_file(path)


def test_excludes_only_sdk_compilation_tools_on_windows_paths():
    for path in (
        r"_rocm_sdk_core\lib\llvm\bin\clang.exe",
        "_rocm_sdk_core/bin/hipcc.exe",
        "_rocm_sdk_core/lib/amdhip64.lib",
        "_rocm_sdk_core/bin/compiler.pdb",
        "torch/lib/aotriton.images/amd-gfx110x/flash/attn_fwd.zip",
    ):
        assert not include_rocm_runtime_file(path)

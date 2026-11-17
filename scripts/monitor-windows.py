"""Read Windows CPU, RAM, GPU engine and GPU memory counters without extra packages."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import statistics
import time
from ctypes import wintypes
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stop-file", type=Path)
    args = parser.parse_args()
    pdh = ctypes.WinDLL("pdh")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    handle_type = ctypes.c_void_p

    class ValueUnion(ctypes.Union):
        _fields_ = [("doubleValue", ctypes.c_double), ("largeValue", ctypes.c_longlong)]

    class Value(ctypes.Structure):
        _fields_ = [("status", wintypes.DWORD), ("value", ValueUnion)]

    class Item(ctypes.Structure):
        _fields_ = [("name", wintypes.LPWSTR), ("value", Value)]

    class Memory(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
            (name, ctypes.c_size_t)
            for name in (
                "peak_working_set",
                "working_set",
                "peak_paged_pool",
                "paged_pool",
                "peak_nonpaged_pool",
                "nonpaged_pool",
                "pagefile",
                "peak_pagefile",
                "private",
            )
        ]

    pdh.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(handle_type)]
    pdh.PdhAddEnglishCounterW.argtypes = [
        handle_type,
        wintypes.LPCWSTR,
        ctypes.c_size_t,
        ctypes.POINTER(handle_type),
    ]
    pdh.PdhCollectQueryData.argtypes = [handle_type]
    pdh.PdhCloseQuery.argtypes = [handle_type]
    pdh.PdhGetFormattedCounterArrayW.argtypes = [
        handle_type,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    ]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = handle_type
    kernel.GetProcessTimes.argtypes = [handle_type] + [ctypes.POINTER(ctypes.c_ulonglong)] * 4
    kernel.CloseHandle.argtypes = [handle_type]
    kernel.GetExitCodeProcess.argtypes = [handle_type, ctypes.POINTER(wintypes.DWORD)]
    psapi.GetProcessMemoryInfo.argtypes = [handle_type, ctypes.POINTER(Memory), wintypes.DWORD]

    query = handle_type()
    if pdh.PdhOpenQueryW(None, 0, ctypes.byref(query)):
        raise OSError("PdhOpenQuery failed")
    process = kernel.OpenProcess(0x0400 | 0x0010, False, args.pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    counters = {}
    for name, path in {
        "engines": r"\GPU Engine(*)\Utilization Percentage",
        "dedicated": r"\GPU Process Memory(*)\Dedicated Usage",
        "shared": r"\GPU Process Memory(*)\Shared Usage",
        "available_mb": r"\Memory\Available MBytes",
    }.items():
        counter = handle_type()
        status = pdh.PdhAddEnglishCounterW(query, path, 0, ctypes.byref(counter))
        if status:
            raise OSError(f"Counter unavailable: {path}: {status:#x}")
        counters[name] = counter

    def values(counter):
        size = wintypes.DWORD()
        count = wintypes.DWORD()
        pdh.PdhGetFormattedCounterArrayW(
            counter, 0x200, ctypes.byref(size), ctypes.byref(count), None
        )
        if not size.value:
            return {}
        buffer = ctypes.create_string_buffer(size.value)
        if pdh.PdhGetFormattedCounterArrayW(
            counter, 0x200, ctypes.byref(size), ctypes.byref(count), buffer
        ):
            return {}
        items = ctypes.cast(buffer, ctypes.POINTER(Item))
        return {
            items[i].name: items[i].value.value.doubleValue
            for i in range(count.value)
            if items[i].value.status in (0, 1)
        }

    def cpu_seconds():
        times = [ctypes.c_ulonglong() for _ in range(4)]
        if not kernel.GetProcessTimes(process, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        return (times[2].value + times[3].value) / 10_000_000

    samples = []
    report = {"pid": args.pid, "logical_cpus": os.cpu_count(), "samples": samples, "summary": {}}
    try:
        pdh.PdhCollectQueryData(query)
        previous_cpu, previous_time = cpu_seconds(), time.monotonic()
        deadline = previous_time + args.seconds
        while time.monotonic() < deadline:
            time.sleep(args.interval)
            exit_code = wintypes.DWORD()
            if (
                (args.stop_file and args.stop_file.exists())
                or not kernel.GetExitCodeProcess(process, ctypes.byref(exit_code))
                or exit_code.value != 259
            ):
                break
            pdh.PdhCollectQueryData(query)
            now, cpu = time.monotonic(), cpu_seconds()
            engines = {
                name: value
                for name, value in values(counters["engines"]).items()
                if re.search(rf"^pid_{args.pid}_", name)
            }
            memory = Memory()
            memory.cb = ctypes.sizeof(memory)
            if not psapi.GetProcessMemoryInfo(process, ctypes.byref(memory), memory.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            row = {
                "utc": time.time(),
                "cpu_core_percent": 100 * (cpu - previous_cpu) / (now - previous_time),
                "cpu_total_percent": 100
                * (cpu - previous_cpu)
                / (now - previous_time)
                / (os.cpu_count() or 1),
                "working_set_bytes": memory.working_set,
                "private_bytes": memory.private,
                "gpu_busy_engine_percent": max(engines.values(), default=0),
                "gpu_engines": engines,
                "dedicated_gpu_bytes": sum(
                    value
                    for name, value in values(counters["dedicated"]).items()
                    if name.startswith(f"pid_{args.pid}_")
                ),
                "shared_gpu_bytes": sum(
                    value
                    for name, value in values(counters["shared"]).items()
                    if name.startswith(f"pid_{args.pid}_")
                ),
                "available_system_mb": next(iter(values(counters["available_mb"]).values()), None),
            }
            samples.append(row)
            previous_cpu, previous_time = cpu, now
            report = {"pid": args.pid, "logical_cpus": os.cpu_count(), "samples": samples}
            report["summary"] = {
                key: {
                    "mean": statistics.mean(row[key] for row in samples),
                    "max": max(row[key] for row in samples),
                }
                for key in (
                    "cpu_core_percent",
                    "cpu_total_percent",
                    "working_set_bytes",
                    "private_bytes",
                    "gpu_busy_engine_percent",
                    "dedicated_gpu_bytes",
                    "shared_gpu_bytes",
                )
            }
            args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report["summary"], indent=2))
    finally:
        pdh.PdhCloseQuery(query)
        kernel.CloseHandle(process)


if __name__ == "__main__":
    main()

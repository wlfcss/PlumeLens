"""Coordinate native Windows GPU queues shared by DirectML and ROCm."""

import threading

WINDOWS_GPU_LOCK = threading.RLock()

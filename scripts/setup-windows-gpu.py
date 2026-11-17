"""Prepare the optional native AMD GPU runtime from a source checkout."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.core.gpu_setup import main

if __name__ == "__main__":
    main()

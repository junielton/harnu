#!/usr/bin/env bash
# Copy the pinned docs snapshot into the run workspace (cwd).
set -euo pipefail
cp -R "$(cd "$(dirname "$0")/../../fixtures" && pwd)/." .

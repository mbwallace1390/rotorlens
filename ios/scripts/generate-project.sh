#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Copyright 2026 Michael Wallace and contributors.

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
ios_directory="$(dirname -- "$script_directory")"
expected_version="$(tr -d '[:space:]' < "$ios_directory/.xcodegen-version")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "XcodeGen $expected_version is required; no project was generated." >&2
  exit 1
fi

actual_version="$(xcodegen --version | awk '{print $NF}' | tail -n 1)"
if [ "$actual_version" != "$expected_version" ]; then
  echo "Expected XcodeGen $expected_version, found $actual_version; no project was generated." >&2
  exit 1
fi

test -f "$ios_directory/../LICENSE"
test -f "$ios_directory/../NOTICE"

cd "$ios_directory"
xcodegen generate --spec project.yml

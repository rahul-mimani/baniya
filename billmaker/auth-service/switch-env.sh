#!/bin/bash
  SRC=".dev.vars.${1:-dev}"
  if [ ! -f "$SRC" ]; then echo "Missing: $SRC"; exit 1; fi
  cp "$SRC" .dev.vars
  echo "✓ Using $1"

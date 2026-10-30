#!/usr/bin/env bash
# shared helpers sourced by the build steps
log() { printf "[%s] %s\n" "$(date -u +%T)" "$*"; }

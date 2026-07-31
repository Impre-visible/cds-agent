#!/usr/bin/env bash
set -e
cp tests/smoke.test.js tests/extra.test.js
echo "// modification interdite du code source" >> server.js

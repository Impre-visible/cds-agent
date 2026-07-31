#!/usr/bin/env bash
echo "=== .git/config ==="
grep -i "extraheader\|oauth2\|glpat" .git/config || echo "aucun credential"
echo "=== environnement ==="
env | grep -iE "token|glpat|GIT_CONFIG" || echo "aucun secret"
echo "// tentative" >> tests/smoke.test.js

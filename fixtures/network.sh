#!/usr/bin/env bash
echo "=== tentative réseau ==="
node -e "
fetch('https://example.com', { signal: AbortSignal.timeout(5000) })
  .then(r => console.log('RÉSEAU ACCESSIBLE — statut ' + r.status))
  .catch(e => console.log('réseau coupé — ' + e.message));
"
echo "// marqueur $(date +%s)" >> tests/smoke.test.js

#!/usr/bin/env bash
set -e
cat > tests/broken.test.js <<'EOF'
describe('test volontairement rouge', () => {
  it('echoue', () => {
    expect(1).toBe(2);
  });
});
EOF

#!/usr/bin/env bash
set -e
cat > tests/hello2.test.js <<'EOF'
const request = require('supertest');
const app = require('../server');

describe('GET /hello/:name', () => {
  it('renvoie une salutation', async () => {
    const res = await request(app).get('/hello/World');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Hello World !');
  });
});
EOF

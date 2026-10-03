#!/usr/bin/env node

/**
 * Monster Quiz Solver - Concurrency & Load Testing Tool
 * 
 * Simulates 30-50 concurrent users accessing the solver to measure:
 * - Response latency (min, max, avg, p95)
 * - HTTP status codes and error rates
 * - Endpoint throughput (req/sec)
 * - Vercel Free tier and Gemini API quota impacts
 *
 * Usage:
 *   node scripts/load-test.js
 *   node scripts/load-test.js --users 50 --duration 15 --url https://your-app.vercel.app
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const TARGET_URL = getArg('url', 'http://localhost:3000');
const USERS = parseInt(getArg('users', '40'), 10);
const DURATION_SEC = parseInt(getArg('duration', '10'), 10);

console.log('\n============================================================');
console.log('       MONSTER QUIZ SOLVER - LOAD & CONCURRENCY TEST         ');
console.log('============================================================');
console.log(`Target URL:         ${TARGET_URL}`);
console.log(`Concurrent Users:   ${USERS}`);
console.log(`Duration:           ${DURATION_SEC} seconds`);
console.log('============================================================\n');

const stats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  statusCodes: {},
  latencies: [],
};

function sendRequest(targetPath, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const url = new URL(targetPath, TARGET_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    const startTime = Date.now();

    const options = {
      method,
      headers: {
        'User-Agent': 'MonsterQuizSolver-LoadTester/1.0',
        'Accept': 'application/json, text/html',
      },
      timeout: 10000,
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latency = Date.now() - startTime;
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          latency,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        status: err.code || 'ERR',
        latency: Date.now() - startTime,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        status: 'TIMEOUT',
        latency: Date.now() - startTime,
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

// Simulates a single user workflow:
// 1. Load app entry (index.html)
// 2. Fetch history API
// 3. Repeat with small natural delay
async function simulateUser(userId, stopTime) {
  while (Date.now() < stopTime) {
    // 1. Load root or static
    const rootRes = await sendRequest('/');
    recordResult(rootRes);

    // 2. History endpoint check
    const histRes = await sendRequest('/api/history');
    recordResult(histRes);

    // Natural simulated user hesitation between 200ms - 800ms
    const pause = Math.floor(Math.random() * 600) + 200;
    await new Promise((r) => setTimeout(r, pause));
  }
}

function recordResult(res) {
  stats.totalRequests++;
  if (res.ok) stats.successRequests++;
  else stats.failedRequests++;

  const code = res.status;
  stats.statusCodes[code] = (stats.statusCodes[code] || 0) + 1;
  stats.latencies.push(res.latency);
}

async function runTest() {
  const startTime = Date.now();
  const stopTime = startTime + (DURATION_SEC * 1000);

  const workers = [];
  for (let i = 1; i <= USERS; i++) {
    workers.push(simulateUser(i, stopTime));
  }

  // Progress ticker
  const interval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rps = (stats.totalRequests / (elapsed || 1)).toFixed(1);
    process.stdout.write(`\r[Running] Elapsed: ${elapsed}s / ${DURATION_SEC}s | Requests: ${stats.totalRequests} | Current: ~${rps} req/s`);
  }, 1000);

  await Promise.all(workers);
  clearInterval(interval);

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const rps = (stats.totalRequests / totalTimeSec).toFixed(1);

  stats.latencies.sort((a, b) => a - b);
  const avg = stats.latencies.length
    ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
    : 0;
  const min = stats.latencies[0] || 0;
  const max = stats.latencies[stats.latencies.length - 1] || 0;
  const p95 = stats.latencies[Math.floor(stats.latencies.length * 0.95)] || 0;

  console.log('\n\n============================================================');
  console.log('                      TEST RESULTS                          ');
  console.log('============================================================');
  console.log(`Duration:              ${totalTimeSec} seconds`);
  console.log(`Concurrent Users:      ${USERS}`);
  console.log(`Total Requests:        ${stats.totalRequests}`);
  console.log(`Successful:            ${stats.successRequests} (${((stats.successRequests / stats.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`Failed:                ${stats.failedRequests}`);
  console.log(`Throughput:            ${rps} requests/second`);
  console.log(`Latency (Avg):         ${avg} ms`);
  console.log(`Latency (Min):         ${min} ms`);
  console.log(`Latency (Max):         ${max} ms`);
  console.log(`Latency (p95):         ${p95} ms`);
  console.log('Status Codes:         ', JSON.stringify(stats.statusCodes));
  console.log('============================================================\n');

  if (stats.failedRequests === 0 && avg < 300) {
    console.log('RESULT: [EXCELLENT] The server easily handles this concurrent user load.');
  } else if (stats.failedRequests === 0) {
    console.log('RESULT: [GOOD] System handled the load with no request drops.');
  } else {
    console.log('RESULT: [ATTENTION] Some requests failed. Review status codes above.');
  }
  console.log('');
}

runTest().catch(console.error);

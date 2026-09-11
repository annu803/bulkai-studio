const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT, 10) || 8080;

// Resolve Replicate token securely from environment / BuildConfig
function isTokenMaskedPlaceholder(token) {
  return typeof token === 'string' && token.includes('*');
}

function getReplicateToken() {
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token || isTokenMaskedPlaceholder(token) || token.startsWith('DEFAULT_') || token === 'YOUR_REPLICATE_API_TOKEN') {
    return '';
  }
  return token;
}

function isTokenConfigured(token) {
  if (!token) return false;
  if (token.startsWith('DEFAULT_') || token === 'YOUR_REPLICATE_API_TOKEN') return false;
  if (isTokenMaskedPlaceholder(token)) return false;
  return true;
}

// Centralized pricing configuration
const PRICING = {
  economyModel: 'minimax/image-01',
  economyCostUsd: 0.01,
  economyCredits: 3,
  premiumModel: 'google/imagen-4',
  premiumCostUsd: 0.04,
  premiumCredits: 8,
  mockCredits: 0
};

// In-memory queue, credits & state
let userCredits = 1250;
let isMockMode = true;
let jobs = [
  {
    id: 'job-init-1',
    jobNumber: '#IMG-1001',
    prompt: 'Ancient Indian stone temple at sunrise with golden mist and sacred lotus pond',
    mode: 'REPLICATE_ECONOMY',
    model: PRICING.economyModel,
    aspectRatio: '1:1',
    quality: 'High',
    style: 'Cinematic',
    status: 'COMPLETED',
    progress: 100,
    creditsCharged: 3,
    estimatedCostUsd: 0.01,
    imageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1000&auto=format&fit=crop&q=80',
    createdAt: Date.now() - 3600000,
    completedAt: Date.now() - 3570000
  },
  {
    id: 'job-init-2',
    jobNumber: '#IMG-1002',
    prompt: 'Majestic royal Bengal tiger in morning mist of Jim Corbett national park',
    mode: 'REPLICATE_PREMIUM',
    model: PRICING.premiumModel,
    aspectRatio: '16:9',
    quality: 'High',
    style: 'Documentary',
    status: 'COMPLETED',
    progress: 100,
    creditsCharged: 8,
    estimatedCostUsd: 0.04,
    imageUrl: 'https://images.unsplash.com/photo-1561731216-c3a4d99437d5?w=1000&auto=format&fit=crop&q=80',
    createdAt: Date.now() - 1800000,
    completedAt: Date.now() - 1765000
  }
];

let nextJobNum = 1003;

// Helper: safe JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Background runner for Replicate prediction
function processReplicateJob(job) {
  const modelIdentifier = job.mode === 'REPLICATE_PREMIUM' ? PRICING.premiumModel : PRICING.economyModel;
  job.status = 'PROCESSING';
  job.progress = 25;

  const currentToken = getReplicateToken();

  if (!currentToken || !isTokenConfigured(currentToken)) {
    job.status = 'FAILED';
    job.progress = 0;
    job.error = 'Valid unmasked REPLICATE_API_TOKEN secret is required. In AI Studio Secrets panel, please ensure your secret is configured without asterisks.';
    userCredits += job.creditsCharged; // Refund credits
    return;
  }

  // Request payload
  const inputPayload = {
    prompt: `${job.prompt}, ${job.style.toLowerCase()} style, high fidelity, 8k resolution`,
    aspect_ratio: job.aspectRatio || '1:1'
  };

  if (modelIdentifier.includes('imagen-4')) {
    inputPayload.output_format = job.quality === 'High' ? 'png' : 'jpg';
  }

  const postData = JSON.stringify({ input: inputPayload });
  const [modelOwner, modelName] = modelIdentifier.split('/');

  const options = {
    hostname: 'api.replicate.com',
    port: 443,
    path: `/v1/models/${modelOwner}/${modelName}/predictions`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=5',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (apiRes) => {
    let raw = '';
    apiRes.on('data', (chunk) => { raw += chunk; });
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(raw);
        if (apiRes.statusCode >= 400) {
          job.status = 'FAILED';
          job.progress = 0;
          job.error = json.detail || `Replicate API error: HTTP ${apiRes.statusCode}`;
          userCredits += job.creditsCharged; // Refund
          return;
        }

        const predictionId = json.id;
        const status = json.status;

        if (status === 'succeeded') {
          job.status = 'COMPLETED';
          job.progress = 100;
          job.imageUrl = Array.isArray(json.output) ? json.output[0] : json.output;
          job.completedAt = Date.now();
        } else if (status === 'failed' || status === 'canceled') {
          job.status = 'FAILED';
          job.progress = 0;
          job.error = json.error || 'Prediction failed on Replicate cluster.';
          userCredits += job.creditsCharged; // Refund
        } else {
          // Poll prediction
          pollPrediction(job, predictionId, Date.now());
        }
      } catch (err) {
        job.status = 'FAILED';
        job.progress = 0;
        job.error = err.message;
        userCredits += job.creditsCharged;
      }
    });
  });

  req.on('error', (err) => {
    job.status = 'FAILED';
    job.progress = 0;
    job.error = `Network error contacting Replicate: ${err.message}`;
    userCredits += job.creditsCharged; // Refund
  });

  req.write(postData);
  req.end();
}

function pollPrediction(job, predictionId, startTime) {
  const pollInterval = 2500;
  const timeoutMs = 120000;

  const timer = setInterval(() => {
    if (Date.now() - startTime > timeoutMs) {
      clearInterval(timer);
      job.status = 'FAILED';
      job.progress = 0;
      job.error = 'Prediction timed out after 120 seconds.';
      userCredits += job.creditsCharged;
      return;
    }

    const options = {
      hostname: 'api.replicate.com',
      port: 443,
      path: `/v1/predictions/${predictionId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${getReplicateToken()}`,
        'Content-Type': 'application/json'
      }
    };

    const pollReq = https.request(options, (pollRes) => {
      let raw = '';
      pollRes.on('data', (chunk) => { raw += chunk; });
      pollRes.on('end', () => {
        try {
          const pollJson = JSON.parse(raw);
          const st = pollJson.status;
          if (st === 'succeeded') {
            clearInterval(timer);
            job.status = 'COMPLETED';
            job.progress = 100;
            job.imageUrl = Array.isArray(pollJson.output) ? pollJson.output[0] : pollJson.output;
            job.completedAt = Date.now();
          } else if (st === 'failed' || st === 'canceled') {
            clearInterval(timer);
            job.status = 'FAILED';
            job.progress = 0;
            job.error = pollJson.error || 'Generation failed on Replicate GPU.';
            userCredits += job.creditsCharged;
          } else {
            job.status = 'PROCESSING';
            job.progress = Math.min(95, (job.progress || 30) + 15);
          }
        } catch (e) {
          // Continue polling
        }
      });
    });

    pollReq.on('error', () => {});
    pollReq.end();
  }, pollInterval);
}

// Mock simulation runner
function processMockJob(job) {
  job.status = 'PROCESSING';
  job.progress = 30;

  setTimeout(() => {
    job.progress = 70;
    setTimeout(() => {
      job.status = 'COMPLETED';
      job.progress = 100;
      job.completedAt = Date.now();
      const mockImages = [
        'https://images.unsplash.com/photo-1548013146-72479768bbaa?w=1000&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=1000&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1506461883276-594a12b11cf3?w=1000&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1000&auto=format&fit=crop&q=80'
      ];
      job.imageUrl = mockImages[Math.floor(Math.random() * mockImages.length)];
    }, 1800);
  }, 1200);
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Health check endpoint for Cloud Run
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'bulkai-studio-backend',
      version: '1.0.0'
    });
  }

  // API Routes
  if (pathname === '/api/status') {
    const currentToken = getReplicateToken();
    const isConfigured = isTokenConfigured(currentToken);
    const rawEnv = (process.env.REPLICATE_API_TOKEN || '').trim();
    const isMasked = isTokenMaskedPlaceholder(rawEnv);
    return sendJson(res, 200, {
      credits: userCredits,
      isMockMode,
      replicateConfigured: isConfigured,
      isTokenMasked: isMasked,
      tokenStatus: isConfigured ? 'Ready (Real Token)' : (isMasked ? 'Masked Asterisks in Secrets' : 'Not Configured'),
      pricing: PRICING
    });
  }

  if (pathname === '/api/jobs' && req.method === 'GET') {
    return sendJson(res, 200, { jobs });
  }

  if (pathname === '/api/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { prompts, mode, aspectRatio, quality, style, count } = payload;

        if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
          return sendJson(res, 400, { error: 'Prompts array cannot be empty.' });
        }

        const selectedMode = mode || 'MOCK';
        let creditCostPerImage = PRICING.mockCredits;
        let estimatedCostUsd = 0;
        let model = 'Local Mock Engine (Simulated)';

        if (selectedMode === 'REPLICATE_ECONOMY') {
          creditCostPerImage = PRICING.economyCredits;
          estimatedCostUsd = PRICING.economyCostUsd;
          model = PRICING.economyModel;
        } else if (selectedMode === 'REPLICATE_PREMIUM') {
          creditCostPerImage = PRICING.premiumCredits;
          estimatedCostUsd = PRICING.premiumCostUsd;
          model = PRICING.premiumModel;
        }

        const imagesMultiplier = count || 1;
        const totalCreditsNeeded = creditCostPerImage * prompts.length * imagesMultiplier;

        if (userCredits < totalCreditsNeeded) {
          return sendJson(res, 402, {
            error: `Insufficient credits. Need ${totalCreditsNeeded} credits, but balance is ${userCredits}.`
          });
        }

        // Reserve credits
        userCredits -= totalCreditsNeeded;

        const newJobs = [];
        prompts.forEach((promptText) => {
          for (let i = 0; i < imagesMultiplier; i++) {
            const job = {
              id: `job-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`,
              jobNumber: `#IMG-${nextJobNum++}`,
              prompt: promptText.trim(),
              mode: selectedMode,
              model: model,
              aspectRatio: aspectRatio || '1:1',
              quality: quality || 'High',
              style: style || 'Cinematic',
              status: 'WAITING',
              progress: 0,
              creditsCharged: creditCostPerImage,
              estimatedCostUsd: estimatedCostUsd,
              createdAt: Date.now()
            };
            jobs.unshift(job);
            newJobs.push(job);

            // Trigger worker
            if (selectedMode === 'MOCK') {
              processMockJob(job);
            } else {
              processReplicateJob(job);
            }
          }
        });

        return sendJson(res, 201, {
          success: true,
          queuedJobs: newJobs,
          remainingCredits: userCredits
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (pathname === '/api/retry' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { jobId } = JSON.parse(body);
        const job = jobs.find(j => j.id === jobId);
        if (!job) return sendJson(res, 404, { error: 'Job not found' });

        if (userCredits < job.creditsCharged) {
          return sendJson(res, 402, { error: 'Insufficient credits to retry' });
        }

        userCredits -= job.creditsCharged;
        job.status = 'WAITING';
        job.error = null;
        job.progress = 0;

        if (job.mode === 'MOCK') {
          processMockJob(job);
        } else {
          processReplicateJob(job);
        }

        return sendJson(res, 200, { success: true, job, remainingCredits: userCredits });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // Serve static HTML/assets from public directory or fallback to index.html
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }

  const ext = path.extname(filePath);
  let contentType = 'text/html';
  if (ext === '.js') contentType = 'application/javascript';
  if (ext === '.css') contentType = 'text/css';
  if (ext === '.json') contentType = 'application/json';
  if (ext === '.png') contentType = 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  if (ext === '.svg') contentType = 'image/svg+xml';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Error loading page: ' + err.message);
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BulkAI Studio Web Server running at http://0.0.0.0:${PORT}`);
});

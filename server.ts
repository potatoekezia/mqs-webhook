import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  // Allow larger payloads for base64 image quiz crops
  app.use(express.json({ limit: '50mb' }));

  // Shared Gemini client creator
  function getGeminiClient(key?: string) {
    const apiKey = key || process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  // Server-side Gemini API solve endpoint
  app.post('/api/gemini/solve', async (req, res) => {
    try {
      const { contents, apiKey } = req.body;

      // Try provided apiKey or fallback to server process.env.GEMINI_API_KEY
      let ai = getGeminiClient(apiKey);
      if (!ai) {
        ai = getGeminiClient(process.env.GEMINI_API_KEY);
      }

      if (!ai) {
        return res.json({
          text: '',
          success: false,
          reason: 'no_key',
          message: 'No API key provided, using local solver.',
        });
      }

      const contentPayload = Array.isArray(contents) ? contents : [contents];
      const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
      let lastReason = 'unknown';

      for (const model of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: contentPayload,
            config: { temperature: 0.1 },
          });

          const text = response?.text ? response.text.trim() : '';
          if (text) {
            return res.json({ text, success: true, model });
          }
        } catch (err: any) {
          const msg = (err && err.message) ? err.message : String(err);
          const is429 = msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
          const is403 = msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('does not have permission');

          if (is429) {
            lastReason = 'quota_exhausted';
            // Try next model in list
            continue;
          }

          if (is403) {
            lastReason = 'permission_denied';
            // If custom key failed with permission denied and server has a different key, try server key
            if (apiKey && process.env.GEMINI_API_KEY && apiKey !== process.env.GEMINI_API_KEY) {
              const serverAi = getGeminiClient(process.env.GEMINI_API_KEY);
              if (serverAi) {
                ai = serverAi;
                continue;
              }
            }
            break;
          }

          lastReason = 'error';
          break;
        }
      }

      // If all models hit quota or permission denied, respond gracefully with HTTP 200
      return res.json({
        text: '',
        success: false,
        reason: lastReason,
        message: 'Gemini rate-limited or unavailable; falling back to local solver.',
      });
    } catch {
      return res.json({
        text: '',
        success: false,
        reason: 'error',
        message: 'Using local solver fallback.',
      });
    }
  });

  // Shared history storage for cross-instance synchronization
  const historyFilePath = path.join(__dirname, 'solver-history.json');
  let sharedHistory: Array<{ id: string; user: string; result: string; timestamp: number }> = [];

  function pruneHistory(list: any[]) {
    if (!Array.isArray(list)) return [];
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const filtered = list
      .filter(item => item && (item.timestamp || 0) >= oneDayAgo)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (filtered.length >= 50) {
      return [];
    }
    return filtered;
  }

  try {
    if (fs.existsSync(historyFilePath)) {
      const data = fs.readFileSync(historyFilePath, 'utf-8');
      sharedHistory = pruneHistory(JSON.parse(data));
    }
  } catch (e) {
    console.warn('Could not load solver-history.json:', e);
  }

  function saveHistoryToFile() {
    try {
      sharedHistory = pruneHistory(sharedHistory);
      fs.writeFileSync(historyFilePath, JSON.stringify(sharedHistory), 'utf-8');
    } catch (e) {
      console.warn('Could not write solver-history.json:', e);
    }
  }

  app.get('/api/history', (_req, res) => {
    sharedHistory = pruneHistory(sharedHistory);
    res.json({ history: sharedHistory });
  });

  app.post('/api/history', (req, res) => {
    try {
      const { entry, history } = req.body || {};
      let modified = false;

      if (Array.isArray(history)) {
        const existingIds = new Set(sharedHistory.map(h => h.id));
        for (const item of history) {
          if (item && item.id && !existingIds.has(item.id)) {
            sharedHistory.push(item);
            existingIds.add(item.id);
            modified = true;
          }
        }
      }

      if (entry && entry.id) {
        const existing = sharedHistory.find(h => h.id === entry.id);
        if (!existing) {
          sharedHistory.unshift(entry);
          modified = true;
        }
      }

      sharedHistory = pruneHistory(sharedHistory);
      if (modified) {
        saveHistoryToFile();
      }

      res.json({ success: true, history: sharedHistory });
    } catch {
      res.status(500).json({ success: false, history: sharedHistory });
    }
  });

  app.delete('/api/history', (_req, res) => {
    sharedHistory = [];
    saveHistoryToFile();
    res.json({ success: true, history: [] });
  });

  // Webhook fallback proxy endpoint
  app.post('/api/webhook/proxy', async (req, res) => {
    try {
      const { url, payload } = req.body;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return res.status(400).json({ success: false, error: 'Invalid or missing webhook URL' });
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.json({ success: response.ok, status: response.status });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e?.message || 'Proxy request failed' });
    }
  });

  // Loader.io verification endpoint
  app.get('/loaderio-a4d07eb0b080983ea5999ef8b78d57fd*', (_req, res) => {
    res.type('text/plain').send('loaderio-a4d07eb0b080983ea5999ef8b78d57fd');
  });

  // Serve static files or Vite middlewares
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer();

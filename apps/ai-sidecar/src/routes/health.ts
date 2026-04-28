import { Router } from 'express';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'tender-ai-sidecar',
    version: '0.0.0',
    qvac: { llm: 'not_loaded', embed: 'not_loaded', ocr: 'not_loaded' },
  });
});

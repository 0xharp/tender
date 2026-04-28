import { Router } from 'express';

export const ocrRouter: Router = Router();

ocrRouter.post('/', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', day: 10 });
});

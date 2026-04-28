import { Router } from 'express';

export const evaluateRouter: Router = Router();

evaluateRouter.post('/', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', day: 10 });
});

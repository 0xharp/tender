import { Router } from 'express';

export const draftRouter: Router = Router();

draftRouter.post('/', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', day: 10 });
});

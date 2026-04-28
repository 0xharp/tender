import { Router } from 'express';

export const translateRouter: Router = Router();

translateRouter.post('/', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', day: 10 });
});

import { AI_SIDECAR_DEFAULT_PORT } from '@tender/shared';
import express from 'express';
import { draftRouter } from './routes/draft.js';
import { evaluateRouter } from './routes/evaluate.js';
import { healthRouter } from './routes/health.js';
import { ocrRouter } from './routes/ocr.js';
import { translateRouter } from './routes/translate.js';

const PORT = Number(process.env.PORT ?? AI_SIDECAR_DEFAULT_PORT);

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use('/health', healthRouter);
app.use('/draft', draftRouter);
app.use('/evaluate', evaluateRouter);
app.use('/translate', translateRouter);
app.use('/ocr', ocrRouter);

app.listen(PORT, () => {
  console.log(`tender ai-sidecar listening on http://localhost:${PORT}`);
});

import { auditEvidence } from './engine.mjs';
import { scanReference } from './core.mjs';
self.onmessage = async event => {
  try {
    const result = await scanReference(event.data.reference, { audit: auditEvidence, progress: stage => self.postMessage({ stage }) });
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: String(error.message).slice(0, 500) }); }
};

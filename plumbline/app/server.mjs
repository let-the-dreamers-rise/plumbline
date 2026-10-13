// Production entry for hosting the static app (Railway etc.): `node server.mjs`, listens on $PORT.
import { serve } from './test/serve.mjs';

const s = await serve(Number(process.env.PORT || 8080), '0.0.0.0');
console.log(`Plumbline app on port ${s.address().port}`);

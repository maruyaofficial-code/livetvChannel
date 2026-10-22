// server.js / app.js integration
// Requirements: Node.js 18+ and express installed.
// Your project must use ES modules ("type": "module" in package.json).

import express from 'express';
import livetvRouter from './livetv.js';

const app = express();

// These paths must match the frontend:
// /hcgi/api/livetv/playlist
// /hcgi/api/livetv/converge/playlist
// /hcgi/api/livetv/converge/stream
// /hcgi/api/livetv/converge/segment
app.use('/hcgi/api/livetv', livetvRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MaruyaLiveTV API listening on port ${PORT}`);
});

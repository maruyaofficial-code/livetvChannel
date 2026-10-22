import express from 'express';
import livetvRouter from './livetv.js';

const app = express();

app.use('/hcgi/api/livetv', livetvRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MaruyaLiveTV API listening on port ${PORT}`);
});

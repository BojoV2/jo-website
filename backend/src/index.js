import dotenv from 'dotenv';
import app from './app.js';

dotenv.config();

const port = process.env.PORT || 8080;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${port}`);
});

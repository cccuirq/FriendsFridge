import { connectDatabase } from './src/db/connection.js';
import { initializeDatabase } from './src/db/schema.js';
import { createApp } from './src/app.js';

const { client, db } = await connectDatabase();
let server;
try {
  await initializeDatabase(db);
  server = createApp(client, db);
  const port = Number(process.env.PORT || 3000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`App running at http://127.0.0.1:${server.address().port}`);
} catch (error) { await client.close(); throw error; }

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.closeConversationEvents();
    server.close(async () => { await client.close(); });
  });
}

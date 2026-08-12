import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';

// Idempotent — safe to run repeatedly. Upserts the channel_accounts row that
// Messenger webhook ingestion keys off of (matched by Page ID).
//   npm run setup:messenger-channel
const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'canvas',
  password: process.env.POSTGRES_PASSWORD ?? 'canvas',
  database: process.env.POSTGRES_DB ?? 'canvas_chat_bot',
  entities: [ChannelAccount],
  synchronize: false,
});

async function run() {
  const pageId = process.env.FB_PAGE_ID;
  if (!pageId) {
    console.error('FB_PAGE_ID is not set in .env — nothing to do.');
    process.exit(1);
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(ChannelAccount);

  const existing = await repo.findOne({
    where: { channel: ChannelType.MESSENGER, externalAccountId: pageId },
  });

  if (existing) {
    console.log(`channel_accounts row already exists for page_id=${pageId} (id=${existing.id})`);
  } else {
    const created = await repo.save(
      repo.create({
        channel: ChannelType.MESSENGER,
        externalAccountId: pageId,
        displayName: process.env.FB_PAGE_NAME ?? 'Facebook Page',
      }),
    );
    console.log(`Created channel_accounts row id=${created.id} for page_id=${pageId}`);
  }

  await dataSource.destroy();
}

run().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

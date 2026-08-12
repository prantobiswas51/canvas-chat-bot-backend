import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';

// Idempotent — safe to run repeatedly. Upserts the channel_accounts row that
// webhook ingestion and outbound sends key off of (matched by phone_number_id).
//   npm run setup:whatsapp-channel
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
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    console.error('WA_PHONE_NUMBER_ID is not set in .env — nothing to do.');
    process.exit(1);
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(ChannelAccount);

  const existing = await repo.findOne({
    where: { channel: ChannelType.WHATSAPP, externalAccountId: phoneNumberId },
  });

  if (existing) {
    console.log(`channel_accounts row already exists for phone_number_id=${phoneNumberId} (id=${existing.id})`);
  } else {
    const created = await repo.save(
      repo.create({
        channel: ChannelType.WHATSAPP,
        externalAccountId: phoneNumberId,
        displayName: process.env.WA_DISPLAY_NAME ?? 'WhatsApp Business Number',
      }),
    );
    console.log(`Created channel_accounts row id=${created.id} for phone_number_id=${phoneNumberId}`);
  }

  await dataSource.destroy();
}

run().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});

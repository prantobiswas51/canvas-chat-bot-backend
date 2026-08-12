import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';
import { Customer } from '../chat/entities/customer.entity';
import { Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Message, MessageSender } from '../chat/entities/message.entity';

// Seeds the same 3 demo conversations as seed_demo_chat.sql, but through the app's
// own TypeORM entities — no separate SQL client needed, just:
//   npm run seed:demo-chat
// NOT idempotent: re-running creates duplicates (no unique constraint on these rows).
const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'canvas',
  password: process.env.POSTGRES_PASSWORD ?? 'canvas',
  database: process.env.POSTGRES_DB ?? 'canvas_chat_bot',
  entities: [ChannelAccount, Customer, Conversation, Message],
  synchronize: false, // the running app already created the schema via synchronize:true
});

async function seed() {
  await dataSource.initialize();

  const channelAccountRepo = dataSource.getRepository(ChannelAccount);
  const customerRepo = dataSource.getRepository(Customer);
  const conversationRepo = dataSource.getRepository(Conversation);
  const messageRepo = dataSource.getRepository(Message);

  const wa = await channelAccountRepo.save(
    channelAccountRepo.create({
      channel: ChannelType.WHATSAPP,
      externalAccountId: '123456123',
      displayName: 'Canvas Art Supplies WhatsApp',
    }),
  );
  const fb = await channelAccountRepo.save(
    channelAccountRepo.create({
      channel: ChannelType.MESSENGER,
      externalAccountId: 'fb-demo-001',
      displayName: 'Canvas Art Supplies FB Page',
    }),
  );
  const ig = await channelAccountRepo.save(
    channelAccountRepo.create({
      channel: ChannelType.INSTAGRAM,
      externalAccountId: 'ig-demo-001',
      displayName: 'Canvas Art Supplies IG',
    }),
  );

  const tanvir = await customerRepo.save(
    customerRepo.create({
      name: 'Tanvir Ahmed',
      phone: '+8801711223344',
      email: 'tanvir.art@gmail.com',
      tags: ['Oil Painter', 'Frequent Buyer'],
    }),
  );
  const nusrat = await customerRepo.save(
    customerRepo.create({
      name: 'Nusrat Jahan',
      phone: '+8801812998877',
      email: 'nusrat.j@yahoo.com',
      tags: ['Bulk Buyer'],
    }),
  );
  const sajid = await customerRepo.save(
    customerRepo.create({
      name: 'Sajid Hossain',
      phone: '+8801915664422',
      email: 'sajid.hossain@outlook.com',
      tags: ['Beginner'],
    }),
  );

  const now = Date.now();

  const conv1 = await conversationRepo.save(
    conversationRepo.create({
      customerId: tanvir.id,
      channelAccountId: wa.id,
      channel: ChannelType.WHATSAPP,
      status: ConversationStatus.AI_ACTIVE,
      lastMessage: 'Which brush is best for oil painting on canvas?',
      lastMessageAt: new Date(now - 2 * 60_000),
      unreadCount: 1,
    }),
  );
  const conv2 = await conversationRepo.save(
    conversationRepo.create({
      customerId: nusrat.id,
      channelAccountId: fb.id,
      channel: ChannelType.MESSENGER,
      status: ConversationStatus.AI_ACTIVE,
      lastMessage: 'Acrylic paint set koto dam?',
      lastMessageAt: new Date(now - 10 * 60_000),
      unreadCount: 0,
    }),
  );
  const conv3 = await conversationRepo.save(
    conversationRepo.create({
      customerId: sajid.id,
      channelAccountId: ig.id,
      channel: ChannelType.INSTAGRAM,
      status: ConversationStatus.HUMAN_MODERATOR,
      lastMessage: 'I need 50 sets of watercolors for our studio.',
      lastMessageAt: new Date(now - 60 * 60_000),
      unreadCount: 2,
    }),
  );

  // Inserted sequentially (not as one bulk array) so createdAt stays in the right
  // chronological order within each thread — @CreateDateColumn stamps "now" on insert.
  const threads: Array<[Conversation, MessageSender, string, string]> = [
    [conv1, MessageSender.CUSTOMER, 'Tanvir Ahmed', 'Hi! Which brush is best for oil painting on canvas?'],
    [
      conv1,
      MessageSender.AI_BOT,
      'Canvas AI Bot',
      'For oil painting on canvas, stiff natural Hog Bristle brushes are best. We recommend our Canvas Imperial Hog Bristle Set (৳1,150 BDT).',
    ],
    [conv2, MessageSender.CUSTOMER, 'Nusrat Jahan', 'Acrylic paint set koto dam?'],
    [
      conv2,
      MessageSender.AI_BOT,
      'Canvas AI Bot',
      'Amader Heavy Body Acrylic Set stock-e ache! Price: ৳1,450 BDT.',
    ],
    [
      conv3,
      MessageSender.CUSTOMER,
      'Sajid Hossain',
      'I need 50 sets of watercolors for our studio. Can we get a bulk discount?',
    ],
    [
      conv3,
      MessageSender.AI_BOT,
      'Canvas AI Bot',
      'Thank you! For bulk order negotiations, I am transferring you to a human moderator right away.',
    ],
    [
      conv3,
      MessageSender.SYSTEM,
      'System',
      'Chat assigned to a human moderator for bulk order follow-up.',
    ],
  ];

  for (const [conversation, senderType, senderName, content] of threads) {
    await messageRepo.save(
      messageRepo.create({ conversationId: conversation.id, senderType, senderName, content }),
    );
  }

  console.log('Seeded 3 channel accounts, 3 customers, 3 conversations, 7 messages.');
  await dataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

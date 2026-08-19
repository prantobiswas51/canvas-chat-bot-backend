// MUST be the very first import. ChatGateway reads process.env.FRONTEND_ORIGIN
// at module-load time (in its @WebSocketGateway decorator), and it gets
// imported transitively (AppModule -> ChatModule -> RealtimeModule ->
// ChatGateway) *before* AppModule's own body runs ConfigModule.forRoot() —
// so without this, .env hasn't been loaded yet when that decorator reads
// process.env, and it silently falls back to the localhost default even in
// production. Loading dotenv here, before anything else, guarantees
// process.env is fully populated before any other file is even imported.
import 'dotenv/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // rawBody: true lets us verify Meta's X-Hub-Signature-256 header on the raw
  // bytes (see WhatsappSignatureGuard) — JSON.stringify(req.body) wouldn't match.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    // Function form (not a static string) so every REST request's CORS
    // decision is logged too — same reasoning as ChatGateway's socket CORS,
    // makes an origin mismatch visible in logs instead of a silent browser-
    // side network error with nothing to go on server-side.
    origin: (origin, callback) => {
      if (!origin || origin === FRONTEND_ORIGIN) {
        callback(null, true);
      } else {
        logger.warn(`CORS REJECTED — origin="${origin}" does not match FRONTEND_ORIGIN="${FRONTEND_ORIGIN}"`);
        callback(null, false);
      }
    },
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Strips @Exclude()-marked fields (e.g. password hash) from all responses.
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Backend listening on http://localhost:${port}/api`);
  logger.log(`CORS/socket handshakes will be accepted from FRONTEND_ORIGIN="${FRONTEND_ORIGIN}"`);
  logger.log(`Postgres: ${process.env.POSTGRES_HOST ?? 'localhost'}:${process.env.POSTGRES_PORT ?? 5432}/${process.env.POSTGRES_DB ?? '(unset)'}`);
  logger.log(`AI provider (default/fallback): ${process.env.AI_PROVIDER ?? 'openai'}`);
}
bootstrap();

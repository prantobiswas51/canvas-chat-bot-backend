console.log('t0', Date.now());
const { NestFactory } = require('@nestjs/core');
console.log('t1 required nestjs/core', Date.now());
const { AppModule } = require('./dist/app.module');
console.log('t2 required AppModule', Date.now());

(async () => {
  console.log('t3 before create', Date.now());
  const app = await NestFactory.create(AppModule);
  console.log('t4 after create', Date.now());
  app.enableCors();
  app.setGlobalPrefix('api');
  await app.listen(3001);
  console.log('t5 listening', Date.now());
})().catch(e => { console.error('ERROR', e); process.exit(1); });

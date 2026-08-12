# Local Dev Notes

## ngrok

Stable static domain (backend, port 3234):

```
https://central-more-panther.ngrok-free.app
```

Start tunnel:

```
ngrok http --domain=central-more-panther.ngrok-free.app 3234
```

WhatsApp webhook URL (Meta App dashboard → WhatsApp → Configuration):

```
https://central-more-panther.ngrok-free.app/api/webhook
```

Verify token = `FB_VERIFY_TOKEN` from `.env`.

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marks a route as exempt from the global JwtAuthGuard — use only for
// endpoints that must work without a logged-in user (login, refresh,
// signup, Meta webhook delivery).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

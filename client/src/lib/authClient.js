// Better Auth React client.
//
// Same-origin: the server mounts the auth handler at /api/auth on port 3000 and serves the
// built client from the same origin in production. In dev, Vite proxies /api to :3000, so
// the client's default baseURL (current origin) plus default basePath (/api/auth) resolves
// correctly in both modes with no extra config. Cookies are sent automatically for
// same-origin requests.
//
// The adminClient plugin adds authClient.admin.* (listUsers, createUser, setRole, banUser,
// unbanUser, removeUser) used by the admin Users page.

import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [adminClient()],
});

export const { useSession, signIn, signOut } = authClient;

export default authClient;

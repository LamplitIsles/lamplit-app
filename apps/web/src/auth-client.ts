import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const auth = createAuthClient({
  plugins: [passkeyClient(), oauthProviderClient()],
});

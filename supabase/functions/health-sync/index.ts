import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { verifyConversationUser } from "../conversation-dispatch/auth.ts";
import { getOwnerUserId } from "../_shared/owner.ts";
import { getSupabaseAdminKey } from "../_shared/supabase_secret.ts";
import { isAllowedBrowserOrigin } from "../_shared/cors.ts";
import type { HealthClient } from "./handler.ts";
import { healthSyncHandler } from "./handler.ts";

Deno.serve(healthSyncHandler({
  verify: (req) =>
    verifyConversationUser(Deno.env.get("SUPABASE_URL")!, {
      apikey: req.headers.get("apikey") ?? "",
      Authorization: req.headers.get("authorization") ?? "",
    }),
  owner: getOwnerUserId(),
  client: createClient(
    Deno.env.get("SUPABASE_URL")!,
    getSupabaseAdminKey(),
  ) as unknown as HealthClient,
  allowedOrigin: isAllowedBrowserOrigin,
}));

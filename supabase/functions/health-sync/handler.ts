export type HealthClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function healthSyncHandler(
  deps: {
    verify: (
      req: Request,
    ) => Promise<
      { ok: true; userId: string } | {
        ok: false;
        status: number;
        error: string;
      }
    >;
    owner: string;
    client: HealthClient;
    allowedOrigin: (origin: string) => boolean;
  },
) {
  return async (req: Request) => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (origin && !deps.allowedOrigin(origin)) {
      return new Response(null, { status: 403, headers });
    }
    if (origin) {
      Object.assign(headers, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "authorization,apikey,content-type,x-client-info",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      });
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (req.method !== "POST") {
      return reply({ error: "method not allowed" }, 405);
    }
    if (!req.headers.get("authorization") || !req.headers.get("apikey")) {
      return reply({ error: "unauthorized" }, 401);
    }
    const auth = await deps.verify(req);
    if (!auth.ok) return reply({ error: auth.error }, auth.status);
    if (auth.userId !== deps.owner) return reply({ error: "forbidden" }, 403);
    try {
      const raw = await req.text();
      if (raw.length > 16_000) return reply({ error: "batch too large" }, 413);
      const body: unknown = JSON.parse(raw);
      if (!object(body) || body.owner !== auth.userId) {
        return reply({ error: "invalid owner" }, 400);
      }
      if (!["read", "upload", "consent"].includes(String(body.action))) {
        return reply({ error: "invalid action" }, 400);
      }
      const { data, error } = await deps.client.rpc("health_steps_gateway", {
        p_owner: auth.userId,
        p_action: body.action,
        p_revision: body.consentVersion ?? null,
        p_mode: body.mode ?? null,
        p_snapshot: body.snapshot ?? null,
      });
      if (error) throw new Error(error.message ?? "unavailable");
      return reply(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = ["sample conflict", "consent changed"].includes(message)
        ? 409
        : /^(invalid|duplicate)/.test(message) || error instanceof SyntaxError
        ? 400
        : 503;
      return reply(
        { error: status === 503 ? "sync unavailable" : message },
        status,
      );
    }
  };
}

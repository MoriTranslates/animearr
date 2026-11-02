/** Routes: Notifications: the bell, setup problems and the extra channels. */
import { setupProblems, withSetupProblems } from "../system/setupHealth.js";
import { bell, channelStatus, markRead, send, testChannel } from "../notify.js";
import { cleanChannels, maskChannel, CHANNEL_TYPES } from "../notifyChannels.js";
import { getTags, sonarrConfigured } from "../arr/sonarr.js";

import { getSettings, patchSettings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { fail, writable } from "./common.js";

export function registerNotifyRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- notifications (bell + test)

  // Setup problems (a download client that fails, a metadata download that failed) count as "Needs action" too.
  app.get("/api/notifications", async () => withSetupProblems(bell(), await setupProblems()));
  app.post<{ Body: { upToId?: number; ids?: number[] } }>("/api/notifications/read", async (req) => {
    writable();
    markRead(
      Number(req.body?.upToId) || 0,
      Array.isArray(req.body?.ids)
        ? req.body.ids
            .map(Number)
            .filter((n) => n > 0)
            .slice(0, 500)
        : [],
    );
    return withSetupProblems(bell(), await setupProblems());
  });
  app.post("/api/notifications/test", async () => {
    const s = getSettings().notify;
    if (!s.discordWebhook && !s.ntfyUrl && !s.channels?.some((c) => c.enabled))
      throw fail("Set up a notification channel first (and save)", 400);
    const out = await send("imported", "Test", "AnimeArr can reach this channel.");
    if (!out.length) throw fail("The 'imported' event is switched off, or too many notifications this minute", 400);
    return { results: out };
  });
  // The extra channels (webhook, Telegram, Pushover, email): secrets masked going out, "masked" means unchanged coming in.
  app.get("/api/notify/channels", async () => ({
    channels: (getSettings().notify.channels ?? []).map(maskChannel),
    status: channelStatus(),
    types: CHANNEL_TYPES,
  }));
  app.put<{ Body: { channels?: unknown } }>("/api/notify/channels", async (req) => {
    writable();
    const channels = cleanChannels(req.body?.channels, getSettings().notify.channels ?? []);
    patchSettings((x) => ({ ...x, notify: { ...x.notify, channels } }));
    return { channels: channels.map(maskChannel), status: channelStatus(), types: CHANNEL_TYPES };
  });
  app.post<{ Params: { id: string } }>("/api/notify/channels/:id/test", async (req) => {
    const c = (getSettings().notify.channels ?? []).find((x) => x.id === req.params.id);
    if (!c) throw fail("Save the channel first, then test it", 404);
    return { results: [await testChannel(c)] };
  });
  /** Library tag filter: Sonarr's tag names (read-only; empty when Sonarr isn't set up or doesn't answer). */
  app.get("/api/library/tags", async () => {
    if (!sonarrConfigured()) return { tags: [] };
    try {
      return { tags: (await getTags()).map((x) => ({ id: x.id, label: x.label })) };
    } catch {
      return { tags: [] };
    }
  });
}

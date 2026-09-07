// Feasibility probe, run from a GitHub runner: can we (a) list a channel's
// uploads via its keyless RSS feed and (b) download the newest video's
// caption track via YouTube's player endpoint, without an API key? Prints one
// line per step so the Actions log is the verdict. Throwaway by design.
const CHANNELS: Record<string, string> = {
  "The Fantasy Footballers": "UCqGPgdY57NiYd-rHLGMaj8w",
  FantasyPros: "UCreYqBhq0uRvxiaXJU-gsGw",
};
const UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

async function main() {
  for (const [name, channelId] of Object.entries(CHANNELS)) {
    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const xml = rss.ok ? await rss.text() : "";
    const vid = xml.match(/<yt:videoId>([^<]+)</)?.[1];
    const title = xml.match(/<media:title>([^<]+)</)?.[1];
    console.log(`[${name}] rss=${rss.status} newest=${vid ?? "-"} "${title ?? ""}"`);
    if (!vid) continue;
    const player = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } },
        videoId: vid,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    const json = (await player.json()) as {
      playabilityStatus?: { status?: string; reason?: string };
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode: string; kind?: string }[] } };
    };
    const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.log(
      `[${name}] player=${player.status} playability=${json.playabilityStatus?.status} ${json.playabilityStatus?.reason ?? ""} tracks=${tracks.map((t) => `${t.languageCode}/${t.kind ?? "manual"}`).join(",")}`
    );
    const en = tracks.find((t) => t.languageCode.startsWith("en"));
    if (!en) continue;
    const cap = await fetch(en.baseUrl, { headers: { "user-agent": UA } });
    const body = await cap.text();
    const words = body.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    console.log(`[${name}] captions=${cap.status} bytes=${body.length} words≈${words} ${words > 200 ? "✅ TRANSCRIPT OK" : "❌ BLOCKED OR EMPTY"}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

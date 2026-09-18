const CONFIG = require("../config.js");

const guides = [
  {
    slug: "choosing-a-minecraft-server", title: "How to choose a Minecraft server", description: "Compare editions, PvP rules, land claims, resets, activity, and purchases before choosing your next Minecraft community.",
    sections: [
      ["Start with how you want to play", "Choose the experience you want to keep after your first week: a protected build, competitive inventory, island economy, or a group project. A popular server can still be the wrong choice if its rules undo the progress you enjoy. Use tags for a shortlist, then read each server's own rules."],
      ["Check edition and connection details", "Choose Java, Bedrock, or a listing that explicitly supports both. Cross-play servers can use different addresses and ports for each edition. A reported software version gives useful context, but does not always describe every client version the server accepts."],
      ["Ask about claims, resets, and progression", "For long-term building, ask whether claims prevent explosions and theft, whether protection expires, and when the world last reset. For competitive play, check team limits and starter gear. For economy play, find out whether seasonal resets remove balances or purchased perks."],
      ["Treat activity as a snapshot", "Player counts show the latest status result available to this directory. They may include AFK players or proxy lobbies. Check the last ping time and visit during the hours you normally play. An unavailable check does not prove that a server has permanently closed."],
      ["Use votes and reviews together", "Votes measure support from participating players; they are not independent quality tests. Read comments for specific experiences and owner replies for context. Sponsored placement is advertising, and a weekly community highlight is a poll result rather than a staff endorsement."],
      ["Try the community before spending", "Join before buying anything. Read the rules, test basic commands, and ask a normal question in chat. Look for a clear description of paid benefits and reset terms. Never share a Microsoft password or recovery code with a server owner."],
      ["Make a practical shortlist", "Pick three servers with the edition and mode you want. Compare claim rules, reset policy, expected play times, and entry requirements. Spend a session on each before deciding where to build, then leave a specific and honest review."]
    ]
  },
  {
    slug: "advertise-your-minecraft-server", title: "Write a Minecraft server listing players can use", description: "Create a useful listing with clear connection details, rules, reset information, original descriptions, and honest expectations.",
    sections: [
      ["Answer joining questions first", "Start with edition, supported versions, address, and whether a whitelist is required. Use the connection fields for ports. For cross-play, test both addresses from the matching edition before publishing."],
      ["Write an original description", "Describe the first session in your own words: where players arrive, how they reach the main world, and which commands matter. Explain the rules that make your world different. Copied descriptions, repeated search phrases, and filler punctuation make a listing less useful."],
      ["Replace claims with details", "Instead of calling the server the best, explain claims, PvP, economy rules, events, support hours, and resets. If a feature is planned but not available, say so. Do not promise uptime or player activity you cannot verify."],
      ["Choose accurate tags and media", "Use tags for gameplay that is available now. Claim Bedrock support only after testing it. Publish banners and trailers you have permission to use, and make sure written details still explain important features."],
      ["Publish, test, and maintain", "Normal submissions publish after automated checks. Open the public page, test its addresses and links, and update the same listing when hosts or worlds change. Avoid duplicate listings. Existing listings remain editable if a later plan change reduces your allowance."],
      ["Ask for honest feedback", "Invite real players to leave specific feedback, including criticism. Owners cannot review their own servers, but can reply. Do not trade rewards for positive ratings or invent testimonials. Daily votes, weekly polls, and paid placement are separate signals."],
      ["Fix a suspended listing", "A temporary suspension stays visible in the owner's dashboard with a reason. Edit that listing and save it for admin review. It remains out of public rankings until approved. Creating a duplicate does not resolve the original issue."]
    ]
  },
  {
    slug: "how-rankings-work", title: "How Icon Listing rankings and moderation work", description: "Understand player counts, votes, review scores, community highlights, sponsored placement, and listing corrections.",
    sections: [
      ["What default order measures", `Ranking combines reported players (weight ${CONFIG.ranking.playerWeight}) and votes (weight ${CONFIG.ranking.voteWeight}). A review average above 3.5 receives an additional score; lower ratings remain public but do not change placement. Rank is not a staff safety test.`],
      ["Advertising and highlights", "Sponsored servers receive a labelled placement boost. The previous weekly poll winner receives a separate community highlight. Neither placement changes public review scores, and the leaderboards offer other ways to compare servers."],
      ["Status checks have limits", "Online status, player count, and version come from Minecraft status checks. Proxies can report a whole network and sleeping hosts can answer differently from their playable world. The last ping time shows how recent the observation is."],
      ["Counters answer different questions", "Votes, monthly voter boards, listing views, website visits, and IP-copy activity are separate measurements. Unique-IP counts can group people on one network or count someone again after an address change; they are not exact audience totals."],
      ["Owners and players supply content", "Descriptions and external links come from owners and are labelled as such. Players submit reviews, owners may reply, and admins can remove abuse. Filters catch some problems but cannot verify every claim."],
      ["Corrections and suspension", "Admins can edit listings or request changes. A suspended listing stays in its owner's dashboard but leaves the public directory. The owner resubmits changes, then an admin approves or requests another correction."],
      ["How to use a ranking", "Treat rank as a starting point. Match your edition, read rules and reviews, check when status was observed, and try the server. Report incorrect or copied information with the listing URL and a specific correction."]
    ]
  }
];

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function html(title, description, pathname, body) {
  const canonical = CONFIG.site.url + pathname;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Icon Listing</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index, follow, max-image-preview:large"><link rel="canonical" href="${canonical}"><meta name="google-adsense-account" content="ca-pub-5157143725251440"><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5157143725251440" crossorigin="anonymous"></script><link rel="icon" href="/assets/icon.png"><link rel="stylesheet" href="/assets/css/styles.css?v=20260918-directory"><script src="/config.js?v=20260918-directory"></script><script defer src="/assets/js/ads.js?v=20260918-directory"></script></head><body data-page="guide"><header class="site-header"><nav class="page nav"><a class="brand" href="/"><img class="brand-icon" src="/assets/icon.png" alt="">Icon Listing</a><a class="nav-link" href="/servers/">Servers</a><a class="nav-link" href="/community/">Community</a><a class="nav-link" href="/guides/">Guides</a></nav></header><main class="page editorial-page"><article><p><a href="/guides/">Minecraft server guides</a></p><h1>${esc(title)}</h1><p class="section-copy">${esc(description)}</p>${body}</article></main></body></html>`;
}
function editorialEntries() {
  const entries = guides.map((g) => ({ filePath: `guides/${g.slug}/index.html`, html: html(g.title, g.description, `/guides/${g.slug}/`, g.sections.map(([h,p]) => `<section class="policy-section"><h2>${esc(h)}</h2><p>${esc(p)}</p></section>`).join("") + '<p><a href="/servers/">Browse Minecraft servers</a></p>') }));
  entries.push({ filePath: "guides/index.html", html: html("Minecraft server guides", "Choose a community, improve your listing, and understand directory rankings.", "/guides/", guides.map((g) => `<section class="policy-section"><h2><a href="/guides/${g.slug}/">${esc(g.title)}</a></h2><p>${esc(g.description)}</p></section>`).join("")) });
  return entries;
}
module.exports = { guides, editorialEntries };

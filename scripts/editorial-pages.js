const CONFIG = require("../config.js");

const guides = [
  {
<<<<<<< Updated upstream
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
=======
    slug: "choosing-a-minecraft-server",
    title: "How to choose a Minecraft server",
    description: "Compare editions, PvP rules, land claims, resets, activity, and purchases before choosing your next Minecraft community.",
    sections: [
      ["Start with the world you want to play in", "Decide what you want to keep after your first week: a protected build, a competitive inventory, an island economy, or a group of friends. A popular server can still be the wrong choice if its rules undo the progress you enjoy. Use the directory's tags to make a shortlist, then read each server's own rules. A Survival tag alone does not tell you whether raiding, stealing, or PvP is allowed."],
      ["Check edition and connection details", "Choose Java, Bedrock, or a listing that explicitly supports both. Cross-play listings can have different addresses and ports for each edition, so copy the matching address from the details page. A server's reported software version is useful context, but it does not necessarily describe every client version it accepts. If you cannot connect, check the owner's supported versions and whitelist requirements before assuming the server is offline."],
      ["Ask about claims, resets, and progression", "For a long-term build, ask whether land claims prevent explosions and theft, whether protection expires while you are away, and when the world last reset. For a competitive world, ask what equipment new players receive and whether teams have size limits. For Skyblock or economy play, find out whether seasonal resets remove balances and purchased perks. These answers are more useful than a long feature list that never explains the rules."],
      ["Read activity as a snapshot", "Player counts show the latest status check available to the directory. They can include AFK players, proxy lobbies, or activity outside your preferred mode. Open the details page and check the last ping time, then visit during the hours you normally play. A smaller server with people online at your time can be a better fit than a much larger community in another time zone. An unavailable status check does not prove that a server has permanently closed."],
      ["Use votes and reviews together", "Votes measure support from participating players; they are not independent quality tests. Read review comments for specific experiences, such as how staff handled a claim dispute or whether a reset was announced. Check owner replies for context. A new listing with no reviews is simply unrated. Sponsored placement is advertising, and the weekly community highlight is a community poll result, not an endorsement by staff."],
      ["Try the community before spending", "Join without making a purchase first. Read the rules, test the basic commands, and ask a normal question in chat. Before buying anything, look for clear descriptions of what the purchase gives you and whether it survives a reset. Never share your Microsoft password or account recovery codes with a server owner. Leave and report a listing if its links or claims appear misleading."],
      ["A practical shortlist", "Pick three servers with the edition and mode you want. Compare claim rules, reset policy, expected play times, and entry requirements. Spend a session on each before deciding where to build. Keep the listing bookmarked so you can return to its connection details, leave an honest review, or find another community if your priorities change."]
    ],
    links: [["Browse the server list", "/servers/"], ["Survival communities", "/servers/survival/"], ["Cross-play communities", "/servers/cross-play/"]]
  },
  {
    slug: "advertise-your-minecraft-server",
    title: "Write a Minecraft server listing players can use",
    description: "Create a useful server listing with clear connection details, rules, reset information, original descriptions, and honest expectations.",
    sections: [
      ["Answer the joining questions first", "Players need to know what they can do, how they connect, and what might stop them joining. Start with your edition, supported versions, address, and whether a whitelist or application is required. Use the listing's connection fields for ports instead of burying them in a promotional paragraph. For cross-play, test both addresses from the matching edition. A working Java address does not prove that Bedrock access is ready."],
      ["Write an original description", "Describe the experience on your server in your own words. Explain the first session: where players arrive, how they reach the main world, and which commands they need. Then describe the rules that make your world different. Do not copy another listing, repeat search phrases, or paste a generic hosting advertisement. Repeating punctuation to reach a character minimum gives visitors less information and can trigger the listing filter."],
      ["Replace vague claims with concrete details", "Instead of 'the best survival experience', explain whether players can claim land, whether PvP is optional, how the economy works, and how staff handle disputes. Instead of 'always active', state when you schedule events and which time zone you use. Instead of 'no resets', explain your actual reset policy and what happens to builds. If a feature is planned but not available yet, say so. Do not promise uptime or support coverage you cannot provide."],
      ["Choose tags and media carefully", "Select tags that describe gameplay currently available. A Java server should only claim Bedrock support after that connection works. Use a readable banner you have permission to publish, and avoid making it the only place that explains a feature. Text inside an image cannot replace the connection fields or written description. A trailer should show your actual server and should not imply features or player numbers that belong to another community."],
      ["Publish, test, and maintain", "Create the listing from your dashboard. Normal submissions publish after the automated checks pass. Open the public details page and test the connection details and external links. When you change host, update the appropriate address and port, then check the next status result. After a reset, update your description and banner rather than creating a duplicate listing. Existing listings remain editable if a later plan change reduces your allowance; adding another listing is subject to your current limit."],
      ["Respond to feedback without manufacturing it", "Invite real players to leave specific feedback, including criticism. Owners cannot review their own servers here, but can reply to reviews. Do not trade rewards for positive star ratings or invent player testimonials. Daily server voting and the weekly community poll are separate activities; explain the difference if you link both to your community. Paid sponsor placement is labelled, and does not mean a server has passed a quality inspection."],
      ["When a listing needs correction", "If an admin temporarily suspends a listing, the dashboard shows the reason. Edit that existing listing and save the corrected information. It enters the review queue and stays out of public rankings until an admin approves it. Creating another listing to bypass a suspension does not resolve the original problem. Include the server name and listing URL when contacting support so the team can identify the record."]
    ],
    links: [["Manage your listings", "/dashboard/"], ["Compare plans", "/sponsored/plans/"], ["Browse current listings", "/servers/"]]
  },
  {
    slug: "how-rankings-work",
    title: "How Icon Listing rankings and moderation work",
    description: "Understand player counts, votes, review scores, community highlights, sponsored placement, and listing corrections on Icon Listing.",
    sections: [
      ["What the default order measures", `The current ranking score combines reported players (weight ${CONFIG.ranking.playerWeight}) and recorded server votes (weight ${CONFIG.ranking.voteWeight}). A review average strictly above 3.5 receives an additional score based on the average (weight ${CONFIG.ranking.reviewWeight}) and up to 50 reviews. Ratings at or below 3.5 remain visible but do not add or subtract ranking points. A high position reflects these signals, not a staff test of the server or a guarantee of safety.`],
      ["Advertising and community highlights", "Sponsored servers receive a large placement boost and are labelled as sponsored. The winner of the previous weekly community poll receives a smaller community-highlight boost. These are separate from daily server votes. The leaderboard also offers ways to compare votes, players, and reviews without treating a promotional position as a review score."],
      ["A status check has limits", "Online status, player count, and reported version come from Minecraft status checks. The last ping time is the best indication of how recent the displayed observation is. A proxy may report players across a network, and a sleeping host may answer differently from the playable world behind it. Counts are not an independent measurement of unique active people. If a result looks wrong, compare the listed host and port with a direct connection before reporting it."],
      ["Different counters answer different questions", "Server votes record support for a listing. Monthly voter boards show votes in their displayed period and should not be read as an all-time traffic total. Website visits, listing views, and IP-copy activity are separate measurements. Unique-IP statistics can group people on a shared connection and can count a person again after their network address changes. They are not an exact audience count or a promise of new players."],
      ["What owners and players contribute", "Server descriptions and external links are supplied by owners. They are not automatically endorsed by Icon Listing. Players can submit a star rating with a short comment, owners can reply, and admins can remove reviews. Automated word filters can catch some abuse, but cannot establish whether every claim is true. Report suspected copied content, misleading connection details, or abusive reviews through the contact page with the specific listing and reason."],
      ["Corrections and temporary suspension", "Admins can edit listings and request changes. A suspended listing remains in its owner's dashboard but is excluded from the public directory. The owner must edit and resubmit it; an admin then approves or requests further corrections. Normal new listings that pass the automated checks publish without this manual queue. This distinction lets routine submissions appear promptly while reported listings receive closer attention."],
      ["How to interpret a recommendation", "Use ranking as a starting point. Match your edition, read the rules, check when the status was observed, and look for concrete player feedback. No score can tell you whether a community fits your preferred play style. Contact us when the directory has incorrect information; include the listing URL and the correction you believe is needed."]
    ],
    links: [["Compare servers", "/servers/"], ["Community poll", "/community/"], ["Report a correction", "/contact/"]]
  }
];

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function documentHtml(title, description, pathname, content) {
  const canonical = `${CONFIG.site.url}${pathname}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} | Icon Listing</title><meta name="description" content="${escape(description)}"><meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${canonical}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${CONFIG.site.url}/assets/icon.png"><meta property="og:type" content="article">
<meta name="google-adsense-account" content="ca-pub-5157143725251440"><link rel="icon" href="/assets/icon.png"><link rel="stylesheet" href="/assets/css/styles.css?v=20260917-directory"><script src="/config.js?v=20260917-directory"></script><script defer src="/assets/js/ads.js?v=20260917-directory"></script>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", name: title, description, url: canonical }).replace(/</g, "\\u003c")}</script>
</head><body data-page="guide"><header class="site-header"><nav class="page nav" aria-label="Main navigation"><a class="brand" href="/"><img class="brand-icon" src="/assets/icon.png" alt="">Icon Listing</a><a class="nav-link" href="/servers/">Servers</a><a class="nav-link" href="/community/">Community</a><a class="nav-link" href="/guides/">Guides</a><a class="nav-link" href="/dashboard/">Dashboard</a></nav></header><main class="page editorial-page"><article><p><a href="/guides/">Minecraft server guides</a></p><h1>${escape(title)}</h1><p class="section-copy">${escape(description)}</p>${content}</article></main><footer class="site-footer"><div class="page footer-inner"><span>Icon Listing is not affiliated with Mojang or Microsoft.</span><nav class="footer-links"><a href="/servers/">Server list</a><a href="/contact/">Contact</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></nav></div></footer></body></html>`;
}

function editorialEntries() {
  const entries = guides.map((guide) => ({
    filePath: `guides/${guide.slug}/index.html`,
    html: documentHtml(guide.title, guide.description, `/guides/${guide.slug}/`, `${guide.sections.map(([heading, text]) => `<section class="policy-section"><h2>${escape(heading)}</h2><p>${escape(text)}</p></section>`).join("")}<nav class="seo-link-grid" aria-label="Next steps">${guide.links.map(([label, href]) => `<a class="seo-link" href="${href}">${escape(label)}</a>`).join("")}</nav>`)
  }));
  entries.push({ filePath: "guides/index.html", html: documentHtml("Minecraft server guides", "Choose a community, improve your listing, and understand what directory rankings mean.", "/guides/", guides.map((guide) => `<section class="policy-section"><h2><a href="/guides/${guide.slug}/">${escape(guide.title)}</a></h2><p>${escape(guide.description)}</p></section>`).join("")) });
  return entries;
}

>>>>>>> Stashed changes
module.exports = { guides, editorialEntries };

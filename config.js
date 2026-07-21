const IconListingConfig = {
  site: {
    name: "Icon Listing",
    owner: "IconRealms",
    url: "https://minecraftlisting.org",
    basePath: "",
    iconPath: "/assets/icon.png",
    discordUrl: "https://discord.gg/HFyUfk458c",
    contactEmail: "officialfnaffanstudios@gmail.com",
    footerNotice:
      "This site is not an official Minecraft service and is not approved by or associated with Mojang or Microsoft.."
  },
  theme: {
    colors: {
      purple: "#8b5cf6",
      pink: "#ec4899",
      black: "#050509",
      blue: "#38bdf8",
      cyan: "#22d3ee",
      green: "#22c55e",
      amber: "#f59e0b",
      surface: "#101018",
      surfaceSoft: "#171724",
      text: "#f7f7fb",
      muted: "#a6a7b7",
      border: "rgba(255,255,255,.12)"
    }
  },
  api: {
    basePath: "/api",
    productionBasePath: "https://icon-listing.vercel.app/api",
    useLocalFallback: true,
    localFallbackHosts: ["", "localhost", "127.0.0.1"],
    requestTimeoutMs: 25000
  },
  seo: {
    defaultTitle: "Best Minecraft Servers 2026 | Icon Listing",
    defaultDescription:
      "Browse top Minecraft servers for SMP, Survival, Skyblock, Factions, Lifesteal, Prison, PvP, Bedrock, and cross-play. Check status and vote.",
    keywords: [
      "minecraft servers",
      "minecraft server list",
      "best minecraft servers",
      "best minecraft servers 2026",
      "top minecraft servers",
      "minecraft smp servers",
      "survival minecraft servers",
      "skyblock servers",
      "prison servers",
      "pvp minecraft servers",
      "bedrock minecraft servers",
      "crossplay minecraft servers",
      "minecraft voting",
      "factions servers",
      "lifesteal servers",
      "minecraft server finder"
    ],
    pages: {
      home: {
        title: "Best Minecraft Servers 2026 | Icon Listing",
        description:
          "Find Minecraft servers by gamemode, rank, votes, status, and player count. Browse SMP, Survival, Skyblock, Factions, Lifesteal, Prison, and PvP."
      },
      servers: {
        title: "Minecraft Server List | SMP, Skyblock, PvP",
        description:
          "Browse a Minecraft server list with SMP, Survival, Skyblock, Factions, Lifesteal, Prison, PvP, Bedrock, Java, and cross-play servers."
      },
      sponsored: {
        title: "Featured Minecraft Servers | Sponsored List",
        description:
          "Discover featured Minecraft servers with sponsored placements, server IPs, tags, live status, player counts, trailers, banners, and vote links."
      },
      sponsoredClients: {
        title: "Minecraft Clients | Sponsored Downloads",
        description:
          "Browse sponsored Minecraft clients with download links, videos, images, pricing, Java and Bedrock support, and client promotion details."
      },
      sponsoredHosts: {
        title: "Minecraft Hosting | Sponsored Hosts",
        description:
          "Browse sponsored Minecraft hosting providers with website links, videos, showcase images, paid sponsor details, and hosting descriptions."
      },
      plans: {
        title: "Icon Listing Plans | Server Listing Limits",
        description:
          "Compare Icon Listing plans for Minecraft server listing limits and sponsored placement durations. Stripe checkout is coming soon."
      },
      motdBuilder: {
        title: "Minecraft MOTD Builder | Icon Listing",
        description:
          "Build a two-line Minecraft server MOTD with color codes, formatting, centering, live preview, copy button, and shareable URL."
      },
      rgbTextGenerator: {
        title: "Minecraft RGB Text Generator | Icon Listing",
        description:
          "Create RGB gradient Minecraft text for chat, ranks, MOTDs, and server messages with hex colors, formatting, preview, and copy output."
      },
      fontsGenerator: {
        title: "Minecraft Fonts Generator | Icon Listing",
        description:
          "Generate Minecraft-ready Unicode fonts including small caps, superscript, subscript, bold, italic, monospace, fullwidth, and styled text."
      },
      votifierTester: {
        title: "Votifier Tester | NuVotifier & AzuVotifier Tool",
        description:
          "Test Votifier, NuVotifier, and AzuVotifier settings for Minecraft vote listeners using host, port, token or public key, and a test username."
      }
    }
  },
  admins: {
    users: ["ItzKuroYT"],
    emails: ["isaaccooper926@gmail.com"]
  },
  security: {
    turnstile: {
      enabled: true,
      siteKey: "0x4AAAAAADtjc0m-E7iHdgVt"
    }
  },
  limits: {
    bannerMaxBytes: 1048576,
    bannerMaxWidth: 468,
    bannerMaxHeight: 60,
    descriptionMinLength: 200,
    pageSize: 10,
    tagsMin: 1,
    tagsMax: 7,
    voteCooldownHours: 24,
    staleServerDeleteDays: 90
  },
  plans: {
    free: {
      name: "Free",
      price: "$0/mo",
      serverLimit: 2,
      sponsorCredits: 0,
      sponsorDurationDays: 0,
      sponsorDurationLabel: "No sponsor slot",
      description: "List up to 2 servers for free."
    },
    premium: {
      name: "Premium",
      price: "$15/mo",
      serverLimit: 5,
      sponsorCredits: 1,
      sponsorDurationDays: 14,
      sponsorDurationLabel: "1 sponsor for 2 weeks",
      description: "Upload up to 5 servers and sponsor one server for 2 weeks while this subscription is active."
    },
    elite: {
      name: "Elite",
      price: "$25/mo",
      serverLimit: 10,
      sponsorCredits: 1,
      sponsorDurationDays: 60,
      sponsorDurationLabel: "1 sponsor for 2 months",
      description: "Upload up to 10 servers and sponsor one server for 2 months while this subscription is active."
    },
    iconic: {
      name: "Iconic",
      price: "$40/mo",
      serverLimit: 15,
      sponsorCredits: 2,
      sponsorDurationDays: 150,
      sponsorDurationLabel: "2 sponsors for 5 months",
      description: "Upload up to 15 servers and sponsor two servers for 5 months while this subscription is active."
    }
  },
  ranking: {
    playerWeight: 1,
    voteWeight: 8,
    sponsoredBoost: 100000
  },
  defaults: {
    javaPort: 25565,
    bedrockPort: 19132
  },
  sponsorship: {
    paypalRequired: true,
    applicationText:
      "To apply for sponsorship, join the Discord server and submit an application. Sponsorships are paid and currently require PayPal.",
    benefits: [
      "Top placement on the homepage.",
      "Top placement on matching tag pages.",
      "Top placement in search results.",
      "Highlighted listing style with a star badge."
    ]
  },
  copy: {
    nav: {
      home: "Home",
      servers: "Servers",
      sponsoredServers: "Sponsored",
      sponsoredClients: "Sponsored Clients",
      sponsoredHosts: "Sponsored Hosts",
      plans: "Plans",
      tools: "Tools",
      dashboard: "Dashboard",
      admin: "Admin",
      login: "Login"
    },
    empty: {
      title: "No servers listed yet",
      body: "Listings will show here after they are submitted and saved.",
      action: "Add a Server"
    },
    home: {
      eyebrow: "Minecraft server list - built for real communities.",
      title: "Best Minecraft Servers",
      body: "Find Minecraft servers by gamemode, live player count, votes, tags, and status. Browse SMP, Survival, Skyblock, Factions, Lifesteal, Prison, PvP, Bedrock, Java, and cross-play communities.",
      browseButton: "Browse servers",
      submitButton: "Submit a server",
      manageButton: "Manage listings",
      sponsoredTitle: "Sponsored Servers",
      sponsoredBody: "Paid placements. Marked separately from the main list.",
      allTitle: "All Servers",
      allBody: "Sorted by rank by default. Use search if you already know what you want."
    },
    servers: {
      title: "Minecraft Server List",
      taggedTitleSuffix: "Servers",
      body: "Search Minecraft servers by name, IP, gamemode, tag, rank, votes, players, and status.",
      searchPlaceholder: "Search by name, IP, or tag"
    },
    sponsoredServers: {
      eyebrow: "Paid placements",
      title: "Sponsored Servers",
      body: "Sponsors get placement above normal results. The listing stays labeled so players know what they are looking at.",
      action: "Ask on Discord",
      benefitsTitle: "What sponsors get",
      applyTitle: "How to apply"
    },
    sponsoredClients: {
      title: "Sponsored Clients",
      body: "Client promotions approved by staff.",
      visitButton: "Website / Download",
      videoButton: "Watch video",
      freeLabel: "Free client",
      paidLabel: "Paid client"
    },
    sponsoredHosts: {
      title: "Sponsored Hosts",
      body: "Paid Minecraft hosting sponsors approved by staff.",
      moreInfoButton: "More info",
      videoButton: "Watch video",
      paidLabel: "Paid sponsor"
    },
    plans: {
      title: "Plans",
      body: "Choose the listing limit and sponsor access that fits your Minecraft community. Stripe checkout is coming soon.",
      comingSoon: "Coming soon",
      currentPlan: "Current plan",
      serverLimitLabel: "server listings",
      sponsorLabel: "sponsor access"
    },
    tools: {
      motdTitle: "MOTD Builder",
      motdBody: "Design a two-line Minecraft server MOTD with a live in-game style preview, centering helper, and shareable URL.",
      rgbTitle: "RGB Text Generator",
      rgbBody: "Build Minecraft RGB gradient text with hex colors, formatting, live preview, and copy-ready output.",
      fontsTitle: "Fonts Generator",
      fontsBody: "Convert plain text into Minecraft-friendly Unicode styles, including small caps, superscript, subscript, and clean display fonts.",
      votifierTitle: "Votifier Tester",
      votifierBody: "Check Votifier, NuVotifier, or AzuVotifier settings before connecting voting to a Minecraft server listing."
    },
    login: {
      title: "Login",
      body: "Log in to manage your server listings.",
      signupPrompt: "Need an account?",
      signupLink: "Sign up below",
      signupTitle: "Sign Up",
      signupBody: "Create an account to submit a server."
    },
    dashboard: {
      loginRequired: "Log in to add and manage server listings.",
      title: "Dashboard",
      body: "Edit listings, check rank, or add another server.",
      addButton: "+ Add Server",
      settingsButton: "Account Settings",
      plansButton: "Plans"
    },
    admin: {
      accessRequired: "Admin access is required for this page.",
      title: "Admin Panel",
      body: "Manage servers, sponsorships, clients, users, and bans.",
      serverListingsTitle: "Server Listings",
      sponsoredClientsTitle: "Sponsored Clients",
      sponsoredClientsBody: "Create and edit sponsored Minecraft client listings.",
      noSponsoredClients: "No sponsored clients yet.",
      sponsoredHostsTitle: "Sponsored Hosts",
      sponsoredHostsBody: "Create and edit paid Minecraft hosting sponsor listings.",
      noSponsoredHosts: "No sponsored hosts yet."
    },
    vote: {
      body: "Enter your Minecraft username so this vote can count on the monthly board.",
      emptyLeaderboard: "No monthly votes yet."
    },
    staticPages: {
      terms: {
        title: "Terms of Service",
        description: "Use Icon Listing responsibly. These terms explain account rules, listing standards, sponsorship limits, enforcement, and acceptable use.",
        updated: "June 30, 2026",
        sections: [
          {
            heading: "Agreement",
            body: "By accessing or using Icon Listing, you agree to use the platform responsibly, honestly, and in compliance with these Terms. If you do not agree, do not create an account, submit listings, vote, or use the service."
          },
          {
            heading: "General Rules",
            bullets: [
              "Only submit Minecraft servers, Minecraft launchers, Minecraft clients, or Minecraft hosting services that you own, manage, or have permission to list.",
              "Do not impersonate another person, community, business, server network, client, host, or brand.",
              "Do not create duplicate listings to gain an unfair advantage.",
              "Do not manipulate rankings, votes, reviews, analytics, traffic, or visibility through bots, alternate accounts, paid vote services, scripts, or other fraudulent methods.",
              "Do not attempt to exploit bugs, bypass limits, scrape private data, overload the API, interfere with normal site operation, or access another account without permission."
            ]
          },
          {
            heading: "Listing Content",
            bullets: [
              "Listings must accurately represent the server, launcher, client, or hosting service being advertised.",
              "Do not include false information, misleading claims, fake player counts, deceptive screenshots, fake links, or unrelated keywords.",
              "Do not upload or link to content that is illegal, hateful, discriminatory, sexually explicit, excessively graphic, abusive, or otherwise inappropriate for a general audience.",
              "Minecraft servers intended for adults are permitted only if the public listing itself remains appropriate for a general audience. Do not include explicit images, explicit descriptions, or links to pornographic or sexually explicit material.",
              "Listings promoting malware, phishing, scams, credential theft, harmful cheats, forced downloads, or other malicious software are strictly prohibited."
            ]
          },
          {
            heading: "Sponsored Listings",
            body: "Icon Listing may offer optional paid sponsorships for sponsored Minecraft servers, sponsored Minecraft launchers or clients, and sponsored Minecraft hosting providers. Sponsored placement increases visibility on the site, but it does not guarantee players, downloads, customers, votes, revenue, search ranking, or any specific result."
          },
          {
            heading: "Accounts",
            bullets: [
              "You are responsible for maintaining the security of your account.",
              "Do not share accounts, sell accounts, or attempt to gain unauthorized access to another user's account.",
              "You are responsible for all activity performed through your account.",
              "You must provide accurate account and listing information, including a reachable email address when required by the signup process."
            ]
          },
          {
            heading: "Votes, Rankings, and Tools",
            body: "Votes, rankings, status checks, Votifier tools, analytics, and related features are provided to help users discover and manage listings. These systems may be limited, adjusted, corrected, or disabled when abuse, technical problems, inaccurate data, or suspicious activity is detected."
          },
          {
            heading: "Minecraft Affiliation",
            body: "Icon Listing is not an official Minecraft service and is not approved by or associated with Mojang, Microsoft, or their affiliates. Minecraft names, marks, and related assets belong to their respective owners."
          },
          {
            heading: "Enforcement",
            body: "We reserve the right to edit, reject, hide, suspend, or remove any listing, vote, account, sponsor placement, or submitted content that violates these Terms or harms the platform. Severe or repeated violations may result in a permanent ban without prior notice."
          },
          {
            heading: "Changes",
            body: "These Terms may be updated at any time. Continued use of Icon Listing after changes are posted means you accept the updated Terms."
          }
        ]
      },
      privacy: {
        title: "Privacy Policy",
        description: "How Icon Listing collects, stores, and uses account data, listing data, email preferences, votes, moderation records, and technical information.",
        updated: "June 30, 2026",
        sections: [
          {
            heading: "Overview",
            body: "Icon Listing collects and stores the information necessary to provide, protect, and maintain the platform. We do not sell your personal information to third parties."
          },
          {
            heading: "Information We Store",
            bullets: [
              "Account information, such as username, email address, encrypted password data, account status, and account creation time.",
              "Email communication preferences, including whether you opted in to news and updates.",
              "Minecraft server, launcher, client, and hosting listings you create or manage.",
              "Votes, copied IP events, listing interactions, plugin vote delivery data, and analytics needed to operate ranking and anti-abuse systems.",
              "Moderation data, reports, bans, deletion records, and administrative actions used to keep the platform safe.",
              "Technical information, such as IP addresses, browser user agent data, request metadata, and security signals used to prevent spam, fraud, abuse, and unauthorized access."
            ]
          },
          {
            heading: "Email Addresses and Updates",
            body: "An email address may be required to create and manage an account. We may use it for account support, security notices, account recovery, important service messages, or listing-related issues. News, updates, and review outreach should only be sent to users who opt in during signup or through a later preference option if available."
          },
          {
            heading: "How We Use Data",
            bullets: [
              "Operate, secure, and improve Icon Listing.",
              "Save and display listings, votes, rankings, sponsorships, and account dashboards.",
              "Prevent spam, fraud, vote manipulation, API abuse, and duplicate or unsafe listings.",
              "Enforce the Terms of Service and handle moderation.",
              "Provide account support, troubleshoot bugs, and maintain backups or recovery records."
            ]
          },
          {
            heading: "Local Storage and Cookies",
            body: "Icon Listing may use browser storage or similar technology to keep you logged in, remember interface state, run security checks, and support normal site features. Third-party services such as Cloudflare Turnstile may process technical signals to verify that login or signup requests are legitimate."
          },
          {
            heading: "Sharing",
            body: "Public listing information is shown publicly on the site and may be indexed by search engines. Private account information is not sold. Data may be shared only when needed to operate infrastructure, comply with law, investigate abuse, protect users, or maintain the service."
          },
          {
            heading: "Your Choices",
            body: "You may request removal of your account and associated personal information, subject to legal, security, anti-abuse, backup, or moderation requirements that may require certain records to be retained for a limited time. You may also choose not to opt in to news and update emails."
          },
          {
            heading: "Security",
            body: "We use reasonable technical measures such as password hashing, session signing, origin checks, captcha verification, and abuse limits to protect the platform. No online service can guarantee perfect security."
          },
          {
            heading: "Changes",
            body: "This Privacy Policy may be updated as Icon Listing changes. Continued use of the platform after changes are posted means the updated policy applies."
          }
        ]
      },
      help: ["Help", "Need help with a listing, vote, sponsorship, or account? Join the Discord or contact the IconRealms team."],
      contact: ["Contact", "Reach IconRealms at officialfnaffanstudios@gmail.com or through Discord."]
    }
  },
  votifier: {
    enabled: true,
    providerEndpoint: "",
    documentationUrl: "https://github.com/NuVotifier/NuVotifier",
    testUsername: "IconListingTest"
  },
  iconListingVotePlugin: {
    downloadPath: "/download/IconListingVotePlugin.jar",
    downloadLabel: "Download Plugin"
  },
  moderation: {
    replacement: "***",
    blockedServerHosts: [
      "falixsrv.me",
      "falixserver.me",
      "aternos.me",
      "aternos.org"
    ],
    blockedWords: [
      "fuck",
      "shit",
      "bitch",
      "asshole",
      "bastard",
      "cunt",
      "dick",
      "pussy",
      "nigger",
      "nigga",
      "faggot",
      "retard",
      "kike",
      "spic",
      "chink",
      "coon",
      "tranny"
    ],
    blockedPatterns: [
      "n[i1!|][gq][gq][e3]r",
      "f[a@]gg[o0]t",
      "r[e3]t[a@]rd"
    ]
  },
  gamemodes: [
    "Survival",
    "Factions",
    "Skyblock",
    "Creative",
    "Anarchy",
    "OneBlock",
    "Economy",
    "PvP",
    "Pixelmon",
    "Lifesteal",
    "KitPvP",
    "Cobblemon",
    "SMP",
    "BoxPvP",
    "Roleplay",
    "Earth",
    "Prison",
    "RPG",
    "Towny",
    "Raiding",
    "Gens",
    "Farming",
    "Vanilla",
    "Minigames",
    "BedWars",
    "Parkour"
  ],
  generalTags: ["Bedrock", "Cross-Play", "Modded", "Whitelist", "New", "Old"],
  countries: [
    "Afghanistan",
    "Albania",
    "Algeria",
    "Andorra",
    "Angola",
    "Antigua and Barbuda",
    "Argentina",
    "Armenia",
    "Australia",
    "Austria",
    "Azerbaijan",
    "Bahamas",
    "Bahrain",
    "Bangladesh",
    "Barbados",
    "Belarus",
    "Belgium",
    "Belize",
    "Benin",
    "Bhutan",
    "Bolivia",
    "Bosnia and Herzegovina",
    "Botswana",
    "Brazil",
    "Brunei",
    "Bulgaria",
    "Burkina Faso",
    "Burundi",
    "Cabo Verde",
    "Cambodia",
    "Cameroon",
    "Canada",
    "Central African Republic",
    "Chad",
    "Chile",
    "China",
    "Colombia",
    "Comoros",
    "Congo",
    "Costa Rica",
    "Cote d'Ivoire",
    "Croatia",
    "Cuba",
    "Cyprus",
    "Czechia",
    "Democratic Republic of the Congo",
    "Denmark",
    "Djibouti",
    "Dominica",
    "Dominican Republic",
    "Ecuador",
    "Egypt",
    "El Salvador",
    "Equatorial Guinea",
    "Eritrea",
    "Estonia",
    "Eswatini",
    "Ethiopia",
    "Fiji",
    "Finland",
    "France",
    "Gabon",
    "Gambia",
    "Georgia",
    "Germany",
    "Ghana",
    "Greece",
    "Grenada",
    "Guatemala",
    "Guinea",
    "Guinea-Bissau",
    "Guyana",
    "Haiti",
    "Honduras",
    "Hungary",
    "Iceland",
    "India",
    "Indonesia",
    "Iran",
    "Iraq",
    "Ireland",
    "Israel",
    "Italy",
    "Jamaica",
    "Japan",
    "Jordan",
    "Kazakhstan",
    "Kenya",
    "Kiribati",
    "Kuwait",
    "Kyrgyzstan",
    "Laos",
    "Latvia",
    "Lebanon",
    "Lesotho",
    "Liberia",
    "Libya",
    "Liechtenstein",
    "Lithuania",
    "Luxembourg",
    "Madagascar",
    "Malawi",
    "Malaysia",
    "Maldives",
    "Mali",
    "Malta",
    "Marshall Islands",
    "Mauritania",
    "Mauritius",
    "Mexico",
    "Micronesia",
    "Moldova",
    "Monaco",
    "Mongolia",
    "Montenegro",
    "Morocco",
    "Mozambique",
    "Myanmar",
    "Namibia",
    "Nauru",
    "Nepal",
    "Netherlands",
    "New Zealand",
    "Nicaragua",
    "Niger",
    "Nigeria",
    "North Korea",
    "North Macedonia",
    "Norway",
    "Oman",
    "Pakistan",
    "Palau",
    "Panama",
    "Papua New Guinea",
    "Paraguay",
    "Peru",
    "Philippines",
    "Poland",
    "Portugal",
    "Qatar",
    "Romania",
    "Russia",
    "Rwanda",
    "Saint Kitts and Nevis",
    "Saint Lucia",
    "Saint Vincent and the Grenadines",
    "Samoa",
    "San Marino",
    "Sao Tome and Principe",
    "Saudi Arabia",
    "Senegal",
    "Serbia",
    "Seychelles",
    "Sierra Leone",
    "Singapore",
    "Slovakia",
    "Slovenia",
    "Solomon Islands",
    "Somalia",
    "South Africa",
    "South Korea",
    "South Sudan",
    "Spain",
    "Sri Lanka",
    "Sudan",
    "Suriname",
    "Sweden",
    "Switzerland",
    "Syria",
    "Taiwan",
    "Tajikistan",
    "Tanzania",
    "Thailand",
    "Timor-Leste",
    "Togo",
    "Tonga",
    "Trinidad and Tobago",
    "Tunisia",
    "Turkey",
    "Turkmenistan",
    "Tuvalu",
    "Uganda",
    "Ukraine",
    "United Arab Emirates",
    "United Kingdom",
    "United States",
    "Uruguay",
    "Uzbekistan",
    "Vanuatu",
    "Vatican City",
    "Venezuela",
    "Vietnam",
    "Yemen",
    "Zambia",
    "Zimbabwe"
  ],
  seedServers: [],
  sponsoredClients: []
};

if (typeof window !== "undefined") {
  window.ICON_LISTING_CONFIG = IconListingConfig;
}

if (typeof module !== "undefined") {
  module.exports = IconListingConfig;
}

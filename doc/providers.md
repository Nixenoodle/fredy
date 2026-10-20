# 🌐 Providers & Scraping

A **provider** is a real-estate platform. When you create a job, you paste the search URL from the
platform into Fredy.

> [!IMPORTANT]
> Always make sure the search results are sorted by **date**, so Fredy picks up the newest listings
> first.

## The 32 built-in providers

**🇩🇪 Germany**

| | | |
|---|---|---|
| 1a Immobilien | Immo Südwest Presse | Neubau Kompass |
| Deutsche Wohnen | Immobilien.de | OhneMakler |
| Engel & Völkers | Immoscout | Regionalimmobilien24 |
| IMAXX | Immowelt | Schwarzes Brett Bremen |
| InBerlinWohnen | Kleinanzeigen | Sparkasse Immobilien |
| McMakler | Wg gesucht | |

**🇩🇪 Germany · 🇦🇹 Austria · 🇨🇭 Switzerland** · BETTERHOMES
**🇦🇹 Austria** · willhaben · Immoscout Österreich
**🇨🇭 Switzerland** · Flatfox
**🇪🇸 Spain · 🇮🇹 Italy · 🇵🇹 Portugal** · idealista
**🇮🇹 Italy** · Subito · Tecnocasa · Tecnorete · Casa.it
**🇫🇷 France** · leboncoin · SeLoger · Bien'ici
**🇳🇱 Netherlands** · Pararius · Kamernet · Funda (experimental)

If you run a portal Fredy does not cover yet, contributions are very welcome, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Pararius

Paste a rental search URL from either `pararius.nl` (Dutch) or `pararius.com` (English), for example
`https://www.pararius.nl/huurwoningen/amsterdam` or
`https://www.pararius.com/apartments/amsterdam`. Set the portal's sorting to **newest first** and copy
the search URL, including any price, room, furnishing or other filters. Fredy starts at the first
page and follows the next-page links, keeping the search filters and reading up to 100 pages per
run. Promoted adverts repeated on several pages are included only once. If a later page is blocked,
the listings already collected are kept and the log warns that the search was incomplete. Narrow
searches larger than 100 pages to collect the rest.

Both sites are fetched through Fredy's existing browser, since plain HTTP requests can receive a
Cloudflare challenge. No account, API key or extra dependency is needed. Browser access was verified
on both domains, but may still be blocked for a particular server/IP; see the proxy guidance below.
Fredy does not solve interactive CAPTCHAs. Availability checks also use the browser; a blocked or
unrecognised page is treated as unknown, not as proof that the advert was removed.

The provider reads the advertised rent, living area, total room count (not bedrooms), street,
postcode, city and preview photo. Descriptions are fetched for new adverts using the same browser.
Maps and geocoding use the Netherlands automatically. The price is the advertised figure, not a
guarantee of an all-inclusive rent. This integration does not provide price tracking.

## Kamernet

Paste a **list-view search URL** from `kamernet.nl`, in Dutch or English, for example:

- Rooms: `https://kamernet.nl/en/for-rent/room-rotterdam?radius=1`
- All property types: `https://kamernet.nl/en/for-rent/properties-rotterdam?radius=1`
- Dutch rooms: `https://kamernet.nl/huren/kamer-rotterdam?radius=1`

Copy the URL after setting the filters on Kamernet. The site encodes some filters as dropdown
indices, not literal values: `maxRent=10` means €1000, not €10, and `maxRent=1000` is not a valid
€1000 filter. The search includes whatever radius the portal sets (so a search can include nearby
towns). Fredy passes the portal's filters through, enforces newest-first sorting, starts at page
one and reads every result page up to a 100-page safety limit. Promoted duplicates are included once;
the separate nearby-property recommendations are not included. Map-view URLs are not supported.

Kamernet currently serves public listings as structured data in its pages, so **no browser, account
or API key is needed** for this provider's requests. For each new listing, Fredy fetches the public
description, address, postcode coordinates and photo gallery. It also supports availability checks
and price tracking. The rent is the advertised amount, with the portal's utilities-included flag
preserved; an apartment's room count stays unknown unless stated, rather than guessing it from the
bedroom count. Postcode coordinates are approximate, not the location of the front door.

Progress appears in the logs as `Kamernet: page ...`, including the unique count and portal total.
If a later page fails, collected listings are retained and a warning identifies the incomplete
search. This does not bypass Kamernet's paid messaging or other account restrictions: contacting
landlords still happens on Kamernet under its usual rules.

## Funda (experimental)

> [!WARNING]
> Funda can reject VPN/proxy exits even when an established browser session still loads it. A fresh
> stock Firefox profile successfully fetched a filtered Rotterdam search without Mullvad; Chromium
> and ordinary HTTP were refused. The Firefox-enabled Docker image launches correctly, but live
> access through the tested Mullvad exit remained blocked. Keep the experimental label until your
> deployment's browser and network are verified together. No private browser session is imported.

Select **Funda (experimental)** and paste a current list-view search URL, for example
`https://www.funda.nl/zoeken/huur?selected_area=rotterdam` or
`https://www.funda.nl/zoeken/koop?selected_area=rotterdam`. Keep the portal's price, area and other
filters in the URL. Map URLs, grouped projects and legacy `/huur/rotterdam/` URLs are not supported;
use the current individual-advert search instead.

The provider uses **stock Firefox**, sorts newest first and walks up to 100 pages (15 results
per page), starting at page one even if another page was pasted. Progress appears as `Funda: page
...`. An initial block fails explicitly; a later failure keeps collected listings and logs an
incomplete-search warning. There is no interactive CAPTCHA solving and no access to your personal
browser profile, cookies or credentials. Puppeteer creates a temporary profile for each browser run.
Other providers continue using CloakBrowser/Chromium; jobs and background probes share browsers only
within the same engine, and close both engines when the run finishes.

**Docker:** rebuild with `docker compose up -d --build`; the Dockerfile installs `firefox-esr`.
**Native Node.js:** install Firefox or Firefox ESR. If it is not found in a standard location, set
`FREDY_FIREFOX_EXECUTABLE` to its executable, not a profile directory. No extra npm package is needed.
The global proxy setting is preserved: HTTP and SOCKS5 proxies without authentication are supported
for Firefox; unsupported/authenticated proxy configurations fail explicitly, never fall back to a
direct connection. VPN routing still applies to the process regardless of that setting.

If toggling a VPN leaves Docker using an unreachable VPN DNS server, recreate Fredy with
`docker compose up -d --force-recreate fredy` after choosing the intended network route. Rebuilding
alone does not fix VPN-exit blocks, and a working DNS resolver does not guarantee Funda accepts an IP.

Search records supply advertised prices, total rooms (not bedrooms), size, address, publication
time and gallery URLs. When detail fetching is enabled for Funda in your user settings, new adverts
are enriched with descriptions, coordinates and build year where available. Availability and price
checks use the browser too. A challenge is unknown, not
proof that an advert was removed. Canonical URLs are deliberately not substituted for search
links, because Funda can give the same advert different ids in the two places.

Only reduced public listing fields are included in test fixtures. User-provided browser snapshots
are not loaded at runtime and do not become a second, permanently stale listing source.

## Immoscout

Immoscout has implemented advanced bot detection. To work around this, Fredy uses a reverse
engineered version of their mobile API, see the
[Immoscout reverse engineering documentation](../reverse-engineered-immoscout.md).

Paste the search URL from your browser as usual. Beside flats and houses this covers plots, garages,
WG rooms, short term lets, assisted living and foreclosures, region, radius and drawn-shape
searches, and the "pretty" URLs the website generates when a search carries a single filter
(`haus-mit-garage-kaufen`, `3-zimmer-wohnung-mieten`, `wohnung-bis-800-euro-warm`, ...). Commercial
searches (offices, shops, gastronomy) are not supported.

Worth knowing:

- A filter that Immoscout's own API does not offer for the type you are searching (a pets filter on
  a house purchase, say) is **dropped** and logged, because sending it makes their API reject the
  whole search.
- A filter Fredy has no translation for yet is dropped as well, and says so in the log:
  `no translator for query parameter "..." ... please report the search URL`. Your search then runs
  **wider** than you set it, so if results look too broad, check the log first.
- If a search URL cannot be mapped at all, the job fails with `Real estate type not found: <path>`.
  Please open an issue with the URL, it is a one line fix.

## Immoscout Österreich

`immobilienscout24.at` is a separate provider (`immoscoutAt`), not a country setting on the German
one. The two websites share nothing you can see: Austria has its own URL scheme
(`/regional/<bundesland>/<gemeinde>/<slug>`), its own filter parameters and its own listing ids.
What they do share is the index behind them, so Fredy reads Austria through the same reverse
engineered mobile API and both providers are thin descriptors over one client.

Paste the search URL from `immobilienscout24.at` as usual. Flats, houses and plots are covered, with
the site's filters for price, living space and room count, whether they sit in the path
(`wohnung-bis-1100-euro-mieten`) or in the query string (`?primaryPriceTo=1100`). Paging and sorting
in the path (`/seite-3`, `/aktualitaet`) are ignored rather than refused - Fredy walks and sorts on
its own.

Three limits, all of them the API's rather than Fredy's:

- **Districts are widened.** The Austrian part of the index files areas by Bundesland and Gemeinde
  and no deeper, so a Viennese district URL searches all of Vienna and says so in the log. Narrow
  the job down with a map area filter if that is too wide.
- **Renting and buying cannot be searched at once.** The API answers a request for both with the
  first of the two and reports nothing about it, so the site's plural pages (`wohnungen`,
  `einfamilienhaeuser`, `3-zimmer-wohnungen`, ...) are refused with the single-deal alternative
  named in the message. `immobilien`, which spans four types, does work.
- **Commercial searches are not supported**, the same as on the German site.

Listings link to `immobilienscout24.de/expose/<id>`. That is not a mistake: an Austrian advert is
served by the German index under a German id, and the API states that page as the advert's own
share link.

**Switzerland is not covered by this provider.** `immoscout24.ch` belongs to a different company and
runs a different platform, with no listings in this index at all. Switzerland is served by Flatfox
and BETTERHOMES.

## idealista

Uses the mobile APIs for idealista.com, idealista.it and idealista.pt, and the search URL determines
the country. `/multi/` URLs are supported, unrelated domains are rejected. Searches with filters or
categories the APIs do not offer fall back to Fredy's browser, which DataDome can block. See the
[provider documentation](../reverse-engineered-idealista.md) for supported endpoints and filters.

## Tecnocasa & Tecnorete

The two agency networks of the Tecnocasa group, listing different adverts. Both sites ignore the
requested sort order, so Fredy reads each search to the end, up to forty pages.

## Casa.it

Uses its mobile API and geography service to translate search URLs. Searches that cannot be
translated into API requests use the job's browser; the fallback reads up to twenty pages and stops
when a page provides no valid results. See the
[provider documentation](../reverse-engineered-casa.md) for supported endpoints and filters.

## BETTERHOMES

One brokerage on three domains - `betterhomes.de`, `betterhomes.at` and `betterhomes.ch` - and a
search url from any of them works. Its results page fills itself from a JSON endpoint, which is
what Fredy asks as well, so this provider needs no browser and costs one request per run.

Paste the search url as usual: every filter it carries is passed on untouched, so anything the
portal offers works whether or not Fredy has heard of it. The exact street is never published on a
BETTERHOMES advert, so a listing is located by its postcode and district. The coordinates the
portal itself shows are its town's centre, so they are only used for an advert without any address.

A rent is stored as the Nettomiete, like every other provider's, because the affordability check
adds the Nebenkosten itself; the Bruttomiete is only the fallback for an advert that states no net
figure.

## leboncoin

France's largest classifieds site, and the one with the most property adverts in the country -
private landlords above all. Paste the address of a search from `leboncoin.fr`, which reads
`https://www.leboncoin.fr/recherche?category=10&locations=...`. Every filter the site offers is
passed on: Fredy translates the url into the request the site's own search page sends, following
the site's own rules, so a filter Fredy has never heard of still reaches leboncoin. Towns with or
without a postcode, departments, regions and a radius around a place are covered, and the other kinds
of place the site writes into its urls (districts, map sections, drawn shapes) are passed on the way
it writes them.

leboncoin sits behind DataDome, and its result pages answer a browser that navigates to them with a
captcha. Fredy therefore opens leboncoin's home page once per run and asks the search endpoint from
inside it, the way the site does; that one navigation is all the browser costs. If a run still ends
with `We have been detected as a bot`, see the proxy section below. A French residential IP suits
leboncoin and SeLoger best; keep in mind that the proxy setting is shared by every browser-based
provider.

Two things leboncoin does not get: detail enrichment, because the search already answers with the
full description, and **price tracking**, because the only place the current price could be read is
the advert page, which is behind the same wall.

## SeLoger

SeLoger runs on the same platform as Immowelt - both belong to the AVIV group - so it is read the
same way, through the search endpoint its own result page uses, from inside a browser session. Paste
the address of a result page, which reads
`https://www.seloger.com/classified-search?distributionTypes=...&locations=AD08FR...`. SeLoger's
landing pages (`/recherche/location/appartement/...`), which spell their search in the path, are
refused with a message saying so: run the search from SeLoger's search form instead.

A filter Fredy cannot translate stops the job and names itself, rather than being dropped and
widening your search, exactly as on Immowelt; the campaign tags a link picks up from an alert mail or
an ad click (`xtor`, `at_medium`, `gclid`, ...) are ignored. SeLoger's results include the adverts of
Belles Demeures, its luxury sister portal, and those link to `bellesdemeures.com`; their full
description is not fetched and their price is not tracked, since that site is not SeLoger's.

Whether a stored advert is still online, and what it costs today, is asked the same way the search
is: from inside a browser session, since SeLoger - like Immowelt - answers any plain request with the
DataDome wall, whether the advert is still there or not. The alive-checker and the price tracker
start one browser per run for it, and only when a SeLoger or Immowelt listing is due.

**Rents are stored the way the card states them.** SeLoger quotes each rent either *charges
comprises* ("cc") or *hors charges* ("hc"), advert by advert, and its result cards give no charges
figure to take a "cc" rent down to the one without them. So a SeLoger rent is sometimes with the
charges and sometimes without, while leboncoin and Bien'ici store it without them wherever the
advert states them. Fredy records which one each stored rent is, and compares rents on the basis
both sides share when it looks for the same flat on two portals. The affordability verdict accounts
for it too: a "cc" rent is already what you pay each month, so it is measured against your warm-rent
ceiling with no Nebenkosten added on top, while an "hc" rent gets the surcharge as before.

## Bien'ici

The portal France's agency networks founded together. Its result page is filled from a public JSON
endpoint, which is what Fredy asks as well, so this provider needs **no browser** and costs one
request per run, plus one place lookup per place in the url once a day. Paste the address of a search from `bienici.com`, which reads
`https://www.bienici.com/recherche/location/paris-75000/appartement?...`. Several places, several
property types and room counts work, and so does every filter the site writes into the query string;
one Fredy does not know stops the job and names itself instead of widening your search.

Rents are stored without charges: Bien'ici quotes them *charges comprises* and states the charges
next to them, so Fredy subtracts them, or takes the advertiser's own figure where one is given. On a
rent-controlled advert that figure is the capped base rent, and the *complément de loyer* on top of
it is added back, since the tenant pays it every month like the rest.

Not supported: an area drawn on the map, a circle and a travel-time area. Bien'ici keeps those on its
own servers and the url carries nothing but an id, so the job stops and says so - search the town
and narrow it down with Fredy's own map area filter instead. A place Bien'ici no longer knows stops
the job too, rather than being searched as whatever its place lookup guesses instead.

## Countries and the map

**Every provider declares the countries it covers**, and the job form puts the matching flag in
front of its name so a mixed list can be read at a glance. The declaration is one line on the
provider's `metaInformation`:

```javascript
export const metaInformation = {
  name: 'your provider name',
  baseUrl: 'https://www.yourprovider.fr/',
  id: 'yourprovider',
  countries: ['fr'],
};
```

Addresses are then geocoded in those countries, and the map opens on them so you can draw a search
area there. A provider spanning several is fine: `countries: ['de', 'at', 'ch']`.

## 🛡️ Bot detection & proxies

Most browser-based providers (kleinanzeigen, wg-gesucht, ohnemakler, ...) are scraped through a
hardened headless browser ([CloakBrowser](https://www.npmjs.com/package/cloakbrowser)). It makes the
**browser fingerprint** indistinguishable from a real Chrome, which is enough when you run Fredy on
a normal home connection.

On a **server / VPS the requests usually originate from a datacenter IP**, and providers behind
anti-bot systems (e.g. AWS CloudFront/WAF) block those based on **IP reputation alone**, no matter
how perfect the fingerprint is. The typical symptom: it works locally but you get
`We have been detected as a bot :-/` on the server.

### The fix: a residential proxy

A **residential proxy** routes Fredy's browser through the internet connection of a real household,
so the provider sees a "normal user" IP instead of a datacenter. For German portals, use a **German
(DE) residential** (or mobile/4G) proxy. Plain VPNs and **datacenter proxies do not help** here,
they share the same bad reputation as your server.

**Configure it** under **Administration → Execution → Proxy URL**. Supported formats:

```
http://user:pass@host:port
socks5://user:pass@host:port
```

Leave the field empty to disable. The proxy applies to all headless-browser providers and takes
effect on the next job run (no restart needed). Immoscout uses a separate mobile API and is not
affected.

### Where to get one

Residential proxies are a paid service (usually billed per GB, Fredy's traffic is small). Well-known
providers offering German residential IPs:

| Provider | Notes |
|---|---|
| [IPRoyal](https://iproyal.com) | Pay-as-you-go, no monthly minimum, good for low volume |
| [Webshare](https://www.webshare.io) | Cheap entry tier, has a small free plan to test with |
| [Decodo (formerly Smartproxy)](https://decodo.com) | Easy setup, country/city targeting |
| [SOAX](https://soax.com) | Residential + mobile, fine-grained geo-targeting |
| [Bright Data](https://brightdata.com) | Largest pool, most features, higher complexity/price |
| [Oxylabs](https://oxylabs.io) | Enterprise-grade, larger plans |

This is not an endorsement, pick whatever fits your budget. For low-volume use like Fredy, a
pay-as-you-go plan (e.g. IPRoyal) or a cheap entry tier (e.g. Webshare) is usually plenty. Select
**Germany** as the proxy location and keep the search interval reasonable, the higher the interval,
the less you look like a bot.

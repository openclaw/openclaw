#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import readline from "node:readline/promises";

const BASE_V2 = "https://api.twitter.com/2";
const BASE_V1 = "https://api.twitter.com/1.1";
const DEFAULT_COUNT = 10;
const MAX_PAGES = 25;
const SEARCH_PAGE_MIN = 10;

const TWEET_FIELDS =
  "id,text,author_id,created_at,conversation_id,public_metrics,referenced_tweets,lang,possibly_sensitive";
const USER_FIELDS = "id,name,username,created_at,verified,description,public_metrics";

const HELP = `twclaw - Twitter/X CLI for OpenClaw

Usage:
  twclaw auth-check

  twclaw read <tweet-url-or-id>
  twclaw thread <tweet-url-or-id>
  twclaw replies <tweet-url-or-id> [-n 20]
  twclaw user <@handle>
  twclaw user-tweets <@handle> [-n 20]

  twclaw home [-n 20]
  twclaw mentions [-n 10]
  twclaw likes <@handle> [-n 10]

  twclaw search "query" [-n 10] [--recent|--popular]
  twclaw trending [--woeid 1]

  twclaw tweet "hello world" [--media image.png]
  twclaw reply <tweet-url-or-id> "great thread!"
  twclaw quote <tweet-url-or-id> "interesting take"

  twclaw like <tweet-url-or-id>
  twclaw unlike <tweet-url-or-id>
  twclaw retweet <tweet-url-or-id>
  twclaw unretweet <tweet-url-or-id>
  twclaw bookmark <tweet-url-or-id>
  twclaw unbookmark <tweet-url-or-id>

  twclaw follow <@handle>
  twclaw unfollow <@handle>
  twclaw followers <@handle> [-n 20]
  twclaw following <@handle> [-n 20]

  twclaw lists
  twclaw list-timeline <list-id> [-n 20]
  twclaw list-add <list-id> <@handle>
  twclaw list-remove <list-id> <@handle>

Options:
  --json          JSON output
  --plain         Plain output (no decoration)
  --no-color      Disable ANSI colors
  -n <count>      Number of results (default: 10)
  --cursor <val>  Pagination cursor
  --all           Fetch all pages (up to safety limit)
  --recent        Search preference: recent
  --popular       Search preference: popular (client-side sort)
  --woeid <id>    WOEID for trending endpoint
  --media <path>  Media file path (tweet command)
  --yes           Skip interactive confirmation for write actions
  -h, --help      Show this help

Environment:
  TWITTER_BEARER_TOKEN (required)
  TWITTER_USER_ID      (optional; recommended for write and timeline actions)
  TWITTER_API_KEY      (optional; status signal for write setup)
  TWITTER_API_SECRET   (optional; status signal for write setup)
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

class ApiError extends Error {
  constructor(status, message, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

const WRITE_COMMANDS = new Set([
  "tweet",
  "reply",
  "quote",
  "like",
  "unlike",
  "retweet",
  "unretweet",
  "bookmark",
  "unbookmark",
  "follow",
  "unfollow",
  "list-add",
  "list-remove",
]);

let cachedMeUserId = null;

function parseArgs(argv) {
  const flags = {
    json: false,
    plain: false,
    noColor: false,
    count: DEFAULT_COUNT,
    cursor: null,
    all: false,
    recent: false,
    popular: false,
    woeid: "1",
    media: null,
    yes: false,
    help: false,
  };

  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--plain") {
      flags.plain = true;
      continue;
    }
    if (arg === "--no-color") {
      flags.noColor = true;
      continue;
    }
    if (arg === "--all") {
      flags.all = true;
      continue;
    }
    if (arg === "--recent") {
      flags.recent = true;
      continue;
    }
    if (arg === "--popular") {
      flags.popular = true;
      continue;
    }
    if (arg === "--yes") {
      flags.yes = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg === "-n") {
      const value = argv[i + 1];
      if (!value) throw new CliError("Missing value for -n");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliError(`Invalid -n value: ${value}`);
      }
      flags.count = parsed;
      i += 1;
      continue;
    }
    if (arg === "--cursor") {
      const value = argv[i + 1];
      if (!value) throw new CliError("Missing value for --cursor");
      flags.cursor = value;
      i += 1;
      continue;
    }
    if (arg === "--woeid") {
      const value = argv[i + 1];
      if (!value) throw new CliError("Missing value for --woeid");
      flags.woeid = value;
      i += 1;
      continue;
    }
    if (arg === "--media") {
      const value = argv[i + 1];
      if (!value) throw new CliError("Missing value for --media");
      flags.media = value;
      i += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { flags, positionals };
}

function bearerToken() {
  const token = process.env.TWITTER_BEARER_TOKEN?.trim() || "";
  if (!token) {
    throw new CliError(
      "TWITTER_BEARER_TOKEN is required. Example: export TWITTER_BEARER_TOKEN='...'.",
    );
  }
  return token;
}

function normalizeHandle(input) {
  const value = String(input || "")
    .trim()
    .replace(/^@/, "");
  if (!value) throw new CliError("Twitter handle is required.");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(value)) {
    throw new CliError(`Invalid handle: ${input}`);
  }
  return value;
}

function parseTweetId(input) {
  const value = String(input || "").trim();
  if (!value) throw new CliError("Tweet URL or ID is required.");

  if (/^\d+$/.test(value)) return value;

  const match = value.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  if (match?.[1]) return match[1];

  throw new CliError(`Could not parse tweet id from: ${value}`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function withQuery(url, query = {}) {
  const out = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out.searchParams.set(key, String(value));
  }
  return out.toString();
}

function parseErrorMessage(payload, fallback) {
  if (!payload) return fallback;

  if (typeof payload?.detail === "string" && payload.detail.trim()) {
    return payload.detail;
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (typeof first?.message === "string" && first.message.trim()) return first.message;
    if (typeof first?.detail === "string" && first.detail.trim()) return first.detail;
    if (typeof first?.title === "string" && first.title.trim()) return first.title;
  }

  if (typeof payload?.title === "string" && payload.title.trim()) {
    return payload.title;
  }

  if (typeof payload?.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return fallback;
}

async function twitterRequest({ method = "GET", base = "v2", path, query, body }) {
  const token = bearerToken();
  const root = base === "v1" ? BASE_V1 : BASE_V2;
  const url = withQuery(`${root}${path}`, query);

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const fallback = `Twitter API request failed (${response.status})`;
    const message = parseErrorMessage(payload, fallback);
    throw new ApiError(response.status, message, payload);
  }

  return payload;
}

function userMapFromIncludes(includes) {
  const map = new Map();
  for (const user of includes?.users ?? []) {
    if (!user?.id) continue;
    map.set(user.id, user);
  }
  return map;
}

function metricFromTweet(tweet) {
  const m = tweet?.public_metrics ?? {};
  return {
    likes: Number(m.like_count ?? 0),
    retweets: Number(m.retweet_count ?? 0),
    replies: Number(m.reply_count ?? 0),
    quotes: Number(m.quote_count ?? 0),
    bookmarks: Number(m.bookmark_count ?? 0),
    impressions: Number(m.impression_count ?? 0),
  };
}

function toTweetView(tweet, usersById = new Map()) {
  const user = usersById.get(tweet.author_id) ?? null;
  const metrics = metricFromTweet(tweet);
  const handle = user?.username || "unknown";

  return {
    id: tweet.id,
    text: tweet.text || "",
    author: user?.name || "Unknown",
    handle,
    created_at: tweet.created_at || "",
    likes: metrics.likes,
    retweets: metrics.retweets,
    replies: metrics.replies,
    quotes: metrics.quotes,
    bookmarks: metrics.bookmarks,
    impressions: metrics.impressions,
    url: tweet.id ? `https://x.com/${handle}/status/${tweet.id}` : "",
  };
}

function toUserView(user) {
  const metrics = user?.public_metrics ?? {};
  return {
    id: user?.id ?? "",
    name: user?.name ?? "",
    username: user?.username ?? "",
    handle: user?.username ? `@${user.username}` : "",
    description: user?.description ?? "",
    verified: Boolean(user?.verified),
    followers: Number(metrics.followers_count ?? 0),
    following: Number(metrics.following_count ?? 0),
    tweets: Number(metrics.tweet_count ?? 0),
    listed: Number(metrics.listed_count ?? 0),
    created_at: user?.created_at ?? "",
    url: user?.username ? `https://x.com/${user.username}` : "",
  };
}

async function getUserByHandle(handleInput) {
  const handle = normalizeHandle(handleInput);
  const payload = await twitterRequest({
    path: `/users/by/username/${encodeURIComponent(handle)}`,
    query: { "user.fields": USER_FIELDS },
  });

  if (!payload?.data?.id) {
    throw new CliError(`User not found: @${handle}`);
  }

  return payload.data;
}

async function getTweetById(tweetId) {
  return twitterRequest({
    path: `/tweets/${tweetId}`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
  });
}

async function getMeUserId() {
  if (cachedMeUserId) return cachedMeUserId;

  const envUserId = process.env.TWITTER_USER_ID?.trim();
  if (envUserId) {
    cachedMeUserId = envUserId;
    return cachedMeUserId;
  }

  const payload = await twitterRequest({ path: "/users/me", query: { "user.fields": "id" } });
  const me = payload?.data?.id;
  if (!me) {
    throw new CliError(
      "Could not resolve current user id. Set TWITTER_USER_ID or use a user-context token.",
    );
  }

  cachedMeUserId = me;
  return cachedMeUserId;
}

async function collectPaginated({
  path,
  query = {},
  count = DEFAULT_COUNT,
  all = false,
  cursor = null,
  minPageSize = 5,
  base = "v2",
}) {
  const items = [];
  const usersById = new Map();
  let nextToken = cursor;
  let page = 0;

  while (page < MAX_PAGES) {
    const remaining = Number.isFinite(count) ? Math.max(1, count - items.length) : 100;
    const pageSize = all ? 100 : clamp(remaining, minPageSize, 100);

    const payload = await twitterRequest({
      base,
      path,
      query: {
        ...query,
        max_results: pageSize,
        ...(nextToken ? { pagination_token: nextToken } : {}),
      },
    });

    const pageItems = Array.isArray(payload?.data) ? payload.data : [];
    for (const item of pageItems) items.push(item);

    const includeUsers = payload?.includes?.users ?? [];
    for (const user of includeUsers) {
      if (user?.id) usersById.set(user.id, user);
    }

    nextToken = payload?.meta?.next_token ?? null;
    page += 1;

    if (!nextToken) break;
    if (!all && items.length >= count) break;
  }

  return {
    items: all ? items : items.slice(0, count),
    usersById,
    nextCursor: nextToken,
  };
}

function paint(text, color, enabled) {
  if (!enabled) return text;
  const map = {
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    gray: "\x1b[90m",
    bold: "\x1b[1m",
  };
  const prefix = map[color] ?? "";
  const reset = "\x1b[0m";
  return `${prefix}${text}${reset}`;
}

function formatTweet(tweet, colors) {
  return [
    `${paint("@" + tweet.handle, "cyan", colors)} ${paint(`(${tweet.author})`, "gray", colors)}`,
    `${tweet.created_at}`,
    `${tweet.text}`,
    `[Likes: ${tweet.likes} | RTs: ${tweet.retweets} | Replies: ${tweet.replies} | Quotes: ${tweet.quotes}]`,
    `${tweet.url}`,
  ].join("\n");
}

function printTweetList(title, tweets, flags) {
  if (flags.json) {
    console.log(JSON.stringify({ count: tweets.length, tweets }, null, 2));
    return;
  }

  const colors = !flags.noColor && !flags.plain && process.stdout.isTTY;
  console.log(paint(title, "bold", colors));
  console.log("");
  for (const tweet of tweets) {
    console.log("---");
    console.log(formatTweet(tweet, colors));
    console.log("");
  }
}

function printUsers(title, users, flags) {
  if (flags.json) {
    console.log(JSON.stringify({ count: users.length, users }, null, 2));
    return;
  }

  const colors = !flags.noColor && !flags.plain && process.stdout.isTTY;
  console.log(paint(title, "bold", colors));
  console.log("");
  for (const user of users) {
    console.log("---");
    console.log(`${paint(user.handle, "cyan", colors)} ${user.name}`);
    if (user.description) console.log(user.description);
    console.log(
      `[Followers: ${user.followers} | Following: ${user.following} | Tweets: ${user.tweets} | Verified: ${user.verified ? "yes" : "no"}]`,
    );
    console.log(user.url);
    console.log("");
  }
}

function printObject(payload, flags) {
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (typeof payload === "string") {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

function ensureArgs(command, args, min) {
  if (args.length < min) {
    throw new CliError(`Missing arguments for ${command}. Run: twclaw --help`);
  }
}

async function confirmWrite(command, summary, flags) {
  if (!WRITE_COMMANDS.has(command)) return;

  if (flags.yes) return;

  if (!process.stdin.isTTY) {
    throw new CliError(
      `Write action blocked in non-interactive mode. Re-run with --yes after user confirmation. (${summary})`,
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${summary}\nProceed? [y/N] `);
  rl.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("Action cancelled by user.", 0);
  }
}

function toEngagementScore(tweet) {
  return (
    Number(tweet.likes || 0) + Number(tweet.retweets || 0) * 2 + Number(tweet.replies || 0) * 2
  );
}

async function commandAuthCheck(flags) {
  const token = bearerToken();
  const result = {
    bearer_token_present: Boolean(token),
    api_key_present: Boolean(process.env.TWITTER_API_KEY),
    api_secret_present: Boolean(process.env.TWITTER_API_SECRET),
  };

  const ping = await twitterRequest({
    path: "/users/by/username/TwitterDev",
    query: { "user.fields": "id,username" },
  });

  result.api_access = Boolean(ping?.data?.id);
  result.message = result.api_access
    ? "Twitter API credentials look valid."
    : "Could not verify Twitter API credentials.";

  printObject(result, flags);
}

async function commandRead(args, flags) {
  ensureArgs("read", args, 1);
  const tweetId = parseTweetId(args[0]);
  const payload = await getTweetById(tweetId);
  const users = userMapFromIncludes(payload?.includes);
  const tweet = toTweetView(payload?.data, users);

  if (flags.json) {
    console.log(JSON.stringify({ tweet }, null, 2));
    return;
  }

  printTweetList("Tweet", [tweet], flags);
}

async function commandThread(args, flags) {
  ensureArgs("thread", args, 1);
  const tweetId = parseTweetId(args[0]);

  const rootPayload = await getTweetById(tweetId);
  const root = rootPayload?.data;
  if (!root?.id) throw new CliError("Tweet not found.");

  const requested = flags.count === DEFAULT_COUNT ? 50 : flags.count;
  const conversationId = root.conversation_id || root.id;
  const page = await collectPaginated({
    path: "/tweets/search/recent",
    query: {
      query: `conversation_id:${conversationId}`,
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: requested,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: SEARCH_PAGE_MIN,
  });

  if (!page.usersById.has(root.author_id)) {
    for (const user of rootPayload?.includes?.users ?? []) {
      if (user?.id) page.usersById.set(user.id, user);
    }
  }

  const known = new Set(page.items.map((tweet) => tweet.id));
  if (!known.has(root.id)) page.items.unshift(root);

  const tweets = page.items
    .map((tweet) => toTweetView(tweet, page.usersById))
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          conversation_id: conversationId,
          count: tweets.length,
          next_cursor: page.nextCursor,
          tweets,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTweetList("Thread", tweets, flags);
}

async function commandReplies(args, flags) {
  ensureArgs("replies", args, 1);
  const tweetId = parseTweetId(args[0]);

  const page = await collectPaginated({
    path: "/tweets/search/recent",
    query: {
      query: `conversation_id:${tweetId} is:reply`,
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: SEARCH_PAGE_MIN,
  });

  const tweets = page.items
    .map((tweet) => toTweetView(tweet, page.usersById))
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));

  if (flags.json) {
    console.log(
      JSON.stringify({ count: tweets.length, next_cursor: page.nextCursor, tweets }, null, 2),
    );
    return;
  }

  printTweetList("Replies", tweets, flags);
}

async function commandUser(args, flags) {
  ensureArgs("user", args, 1);
  const user = await getUserByHandle(args[0]);
  const view = toUserView(user);

  if (flags.json) {
    console.log(JSON.stringify({ user: view }, null, 2));
    return;
  }

  printUsers("User", [view], flags);
}

async function commandUserTweets(args, flags) {
  ensureArgs("user-tweets", args, 1);
  const user = await getUserByHandle(args[0]);

  const page = await collectPaginated({
    path: `/users/${user.id}/tweets`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
      exclude: "retweets",
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  if (!page.usersById.has(user.id)) page.usersById.set(user.id, user);

  const tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.json) {
    console.log(
      JSON.stringify(
        { user: toUserView(user), count: tweets.length, next_cursor: page.nextCursor, tweets },
        null,
        2,
      ),
    );
    return;
  }

  printTweetList(`Tweets by @${user.username}`, tweets, flags);
}

async function commandHome(flags) {
  const me = await getMeUserId();
  const page = await collectPaginated({
    path: `/users/${me}/timelines/reverse_chronological`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.json) {
    console.log(
      JSON.stringify({ count: tweets.length, next_cursor: page.nextCursor, tweets }, null, 2),
    );
    return;
  }

  printTweetList("Home Timeline", tweets, flags);
}

async function commandMentions(flags) {
  const me = await getMeUserId();
  const page = await collectPaginated({
    path: `/users/${me}/mentions`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.json) {
    console.log(
      JSON.stringify({ count: tweets.length, next_cursor: page.nextCursor, tweets }, null, 2),
    );
    return;
  }

  printTweetList("Mentions", tweets, flags);
}

async function commandLikes(args, flags) {
  ensureArgs("likes", args, 1);
  const user = await getUserByHandle(args[0]);

  const page = await collectPaginated({
    path: `/users/${user.id}/liked_tweets`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.json) {
    console.log(
      JSON.stringify(
        { user: toUserView(user), count: tweets.length, next_cursor: page.nextCursor, tweets },
        null,
        2,
      ),
    );
    return;
  }

  printTweetList(`Liked by @${user.username}`, tweets, flags);
}

async function commandSearch(args, flags) {
  ensureArgs("search", args, 1);
  if (flags.recent && flags.popular) {
    throw new CliError("Use either --recent or --popular, not both.");
  }

  const queryText = args.join(" ").trim();
  if (!queryText) throw new CliError("Search query is required.");

  const page = await collectPaginated({
    path: "/tweets/search/recent",
    query: {
      query: queryText,
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: SEARCH_PAGE_MIN,
  });

  let tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.popular) {
    tweets = [...tweets].sort((a, b) => toEngagementScore(b) - toEngagementScore(a));
  } else {
    tweets = [...tweets].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          query: queryText,
          mode: flags.popular ? "popular" : "recent",
          count: tweets.length,
          next_cursor: page.nextCursor,
          tweets,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTweetList(`Search: ${queryText}`, tweets, flags);
}

async function commandTrending(flags) {
  const payload = await twitterRequest({
    base: "v1",
    path: "/trends/place.json",
    query: { id: flags.woeid },
  });

  const first = Array.isArray(payload) ? payload[0] : null;
  const trends = Array.isArray(first?.trends) ? first.trends : [];
  const items = trends.map((trend) => ({
    name: trend?.name || "",
    query: trend?.query || "",
    tweet_volume: trend?.tweet_volume ?? null,
    url: trend?.url || "",
  }));

  if (flags.json) {
    console.log(
      JSON.stringify({ woeid: flags.woeid, count: items.length, trends: items }, null, 2),
    );
    return;
  }

  const colors = !flags.noColor && !flags.plain && process.stdout.isTTY;
  console.log(paint(`Trending topics (WOEID ${flags.woeid})`, "bold", colors));
  console.log("");
  for (const trend of items) {
    const volume = trend.tweet_volume === null ? "n/a" : String(trend.tweet_volume);
    console.log(`- ${paint(trend.name, "cyan", colors)} [volume: ${volume}]`);
    if (trend.url) console.log(`  ${trend.url}`);
  }
}

async function commandTweet(args, flags) {
  ensureArgs("tweet", args, 1);
  const text = args.join(" ").trim();
  if (!text) throw new CliError("Tweet text is required.");

  if (flags.media) {
    if (!fs.existsSync(flags.media)) {
      throw new CliError(`Media file not found: ${flags.media}`);
    }
    throw new CliError(
      "--media is not supported in this build (Twitter media upload requires OAuth 1.0a user auth).",
    );
  }

  await confirmWrite("tweet", `About to post tweet:\n\"${text}\"`, flags);

  const payload = await twitterRequest({ method: "POST", path: "/tweets", body: { text } });
  const tweetId = payload?.data?.id;

  printObject(
    {
      ok: true,
      action: "tweet",
      id: tweetId,
      url: tweetId ? `https://x.com/i/web/status/${tweetId}` : null,
      text,
    },
    flags,
  );
}

async function commandReply(args, flags) {
  ensureArgs("reply", args, 2);
  const tweetId = parseTweetId(args[0]);
  const text = args.slice(1).join(" ").trim();
  if (!text) throw new CliError("Reply text is required.");

  await confirmWrite("reply", `About to reply to ${tweetId}:\n\"${text}\"`, flags);

  const payload = await twitterRequest({
    method: "POST",
    path: "/tweets",
    body: { text, reply: { in_reply_to_tweet_id: tweetId } },
  });

  const id = payload?.data?.id;
  printObject(
    {
      ok: true,
      action: "reply",
      in_reply_to_tweet_id: tweetId,
      id,
      url: id ? `https://x.com/i/web/status/${id}` : null,
      text,
    },
    flags,
  );
}

async function commandQuote(args, flags) {
  ensureArgs("quote", args, 2);
  const tweetId = parseTweetId(args[0]);
  const text = args.slice(1).join(" ").trim();
  if (!text) throw new CliError("Quote text is required.");

  await confirmWrite("quote", `About to quote ${tweetId}:\n\"${text}\"`, flags);

  const payload = await twitterRequest({
    method: "POST",
    path: "/tweets",
    body: { text, quote_tweet_id: tweetId },
  });

  const id = payload?.data?.id;
  printObject(
    {
      ok: true,
      action: "quote",
      quote_tweet_id: tweetId,
      id,
      url: id ? `https://x.com/i/web/status/${id}` : null,
      text,
    },
    flags,
  );
}

async function performTweetAction(command, tweetInput, flags) {
  ensureArgs(command, [tweetInput].filter(Boolean), 1);
  const tweetId = parseTweetId(tweetInput);
  const me = await getMeUserId();

  const config = {
    like: { method: "POST", path: `/users/${me}/likes`, body: { tweet_id: tweetId } },
    unlike: { method: "DELETE", path: `/users/${me}/likes/${tweetId}` },
    retweet: { method: "POST", path: `/users/${me}/retweets`, body: { tweet_id: tweetId } },
    unretweet: { method: "DELETE", path: `/users/${me}/retweets/${tweetId}` },
    bookmark: { method: "POST", path: `/users/${me}/bookmarks`, body: { tweet_id: tweetId } },
    unbookmark: { method: "DELETE", path: `/users/${me}/bookmarks/${tweetId}` },
  }[command];

  if (!config) throw new CliError(`Unsupported action: ${command}`);

  await confirmWrite(command, `About to ${command} tweet ${tweetId}.`, flags);

  const payload = await twitterRequest({
    method: config.method,
    path: config.path,
    body: config.body,
  });

  printObject(
    {
      ok: true,
      action: command,
      tweet_id: tweetId,
      response: payload?.data ?? payload,
    },
    flags,
  );
}

async function performFollowAction(command, handleInput, flags) {
  ensureArgs(command, [handleInput].filter(Boolean), 1);
  const me = await getMeUserId();
  const targetUser = await getUserByHandle(handleInput);

  await confirmWrite(command, `About to ${command} @${targetUser.username}.`, flags);

  if (command === "follow") {
    const payload = await twitterRequest({
      method: "POST",
      path: `/users/${me}/following`,
      body: { target_user_id: targetUser.id },
    });

    printObject(
      {
        ok: true,
        action: "follow",
        target: toUserView(targetUser),
        response: payload?.data ?? payload,
      },
      flags,
    );
    return;
  }

  if (command === "unfollow") {
    const payload = await twitterRequest({
      method: "DELETE",
      path: `/users/${me}/following/${targetUser.id}`,
    });

    printObject(
      {
        ok: true,
        action: "unfollow",
        target: toUserView(targetUser),
        response: payload?.data ?? payload,
      },
      flags,
    );
    return;
  }

  throw new CliError(`Unsupported follow action: ${command}`);
}

async function commandFollowers(args, flags, mode) {
  ensureArgs(mode, args, 1);
  const user = await getUserByHandle(args[0]);
  const path = mode === "followers" ? `/users/${user.id}/followers` : `/users/${user.id}/following`;

  const page = await collectPaginated({
    path,
    query: { "user.fields": USER_FIELDS },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const users = page.items.map(toUserView);

  if (flags.json) {
    console.log(
      JSON.stringify(
        { user: toUserView(user), count: users.length, next_cursor: page.nextCursor, users },
        null,
        2,
      ),
    );
    return;
  }

  printUsers(
    `${mode === "followers" ? "Followers" : "Following"} of @${user.username}`,
    users,
    flags,
  );
}

async function commandLists(flags) {
  const me = await getMeUserId();
  const page = await collectPaginated({
    path: `/users/${me}/owned_lists`,
    query: { "list.fields": "id,name,description,follower_count,member_count,private" },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const lists = page.items.map((list) => ({
    id: list?.id ?? "",
    name: list?.name ?? "",
    description: list?.description ?? "",
    followers: Number(list?.follower_count ?? 0),
    members: Number(list?.member_count ?? 0),
    private: Boolean(list?.private),
  }));

  if (flags.json) {
    console.log(
      JSON.stringify({ count: lists.length, next_cursor: page.nextCursor, lists }, null, 2),
    );
    return;
  }

  const colors = !flags.noColor && !flags.plain && process.stdout.isTTY;
  console.log(paint("Lists", "bold", colors));
  console.log("");
  for (const list of lists) {
    console.log(`- ${paint(list.name, "cyan", colors)} (${list.id})`);
    if (list.description) console.log(`  ${list.description}`);
    console.log(
      `  [Followers: ${list.followers} | Members: ${list.members} | Private: ${list.private ? "yes" : "no"}]`,
    );
  }
}

async function commandListTimeline(args, flags) {
  ensureArgs("list-timeline", args, 1);
  const listId = args[0].trim();
  if (!listId) throw new CliError("List id is required.");

  const page = await collectPaginated({
    path: `/lists/${encodeURIComponent(listId)}/tweets`,
    query: {
      expansions: "author_id",
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
    },
    count: flags.count,
    all: flags.all,
    cursor: flags.cursor,
    minPageSize: 5,
  });

  const tweets = page.items.map((tweet) => toTweetView(tweet, page.usersById));

  if (flags.json) {
    console.log(
      JSON.stringify(
        { list_id: listId, count: tweets.length, next_cursor: page.nextCursor, tweets },
        null,
        2,
      ),
    );
    return;
  }

  printTweetList(`List timeline: ${listId}`, tweets, flags);
}

async function commandListMembership(command, args, flags) {
  ensureArgs(command, args, 2);
  const listId = args[0].trim();
  const handle = args[1];
  if (!listId) throw new CliError("List id is required.");

  const user = await getUserByHandle(handle);

  await confirmWrite(
    command,
    `About to ${command} @${user.username} ${command === "list-add" ? "to" : "from"} list ${listId}.`,
    flags,
  );

  if (command === "list-add") {
    const payload = await twitterRequest({
      method: "POST",
      path: `/lists/${encodeURIComponent(listId)}/members`,
      body: { user_id: user.id },
    });

    printObject(
      {
        ok: true,
        action: "list-add",
        list_id: listId,
        user: toUserView(user),
        response: payload?.data ?? payload,
      },
      flags,
    );
    return;
  }

  if (command === "list-remove") {
    const payload = await twitterRequest({
      method: "DELETE",
      path: `/lists/${encodeURIComponent(listId)}/members/${user.id}`,
    });

    printObject(
      {
        ok: true,
        action: "list-remove",
        list_id: listId,
        user: toUserView(user),
        response: payload?.data ?? payload,
      },
      flags,
    );
    return;
  }

  throw new CliError(`Unsupported list action: ${command}`);
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));

  if (flags.help || positionals.length === 0) {
    console.log(HELP.trim());
    return;
  }

  const [command, ...args] = positionals;

  switch (command) {
    case "auth-check":
      await commandAuthCheck(flags);
      return;
    case "read":
      await commandRead(args, flags);
      return;
    case "thread":
      await commandThread(args, flags);
      return;
    case "replies":
      await commandReplies(args, flags);
      return;
    case "user":
      await commandUser(args, flags);
      return;
    case "user-tweets":
      await commandUserTweets(args, flags);
      return;
    case "home":
      await commandHome(flags);
      return;
    case "mentions":
      await commandMentions(flags);
      return;
    case "likes":
      await commandLikes(args, flags);
      return;
    case "search":
      await commandSearch(args, flags);
      return;
    case "trending":
      await commandTrending(flags);
      return;
    case "tweet":
      await commandTweet(args, flags);
      return;
    case "reply":
      await commandReply(args, flags);
      return;
    case "quote":
      await commandQuote(args, flags);
      return;
    case "like":
    case "unlike":
    case "retweet":
    case "unretweet":
    case "bookmark":
    case "unbookmark":
      await performTweetAction(command, args[0], flags);
      return;
    case "follow":
    case "unfollow":
      await performFollowAction(command, args[0], flags);
      return;
    case "followers":
      await commandFollowers(args, flags, "followers");
      return;
    case "following":
      await commandFollowers(args, flags, "following");
      return;
    case "lists":
      await commandLists(flags);
      return;
    case "list-timeline":
      await commandListTimeline(args, flags);
      return;
    case "list-add":
    case "list-remove":
      await commandListMembership(command, args, flags);
      return;
    default:
      throw new CliError(`Unknown command: ${command}. Run: twclaw --help`);
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    if (err.message) console.error(err.message);
    process.exit(err.exitCode ?? 1);
  }

  if (err instanceof ApiError) {
    if (err.status === 401) {
      console.error("401 Unauthorized: check TWITTER_BEARER_TOKEN.");
    } else if (err.status === 429) {
      console.error("429 Rate limited: wait and retry.");
    }
    console.error(`Twitter API error (${err.status}): ${err.message}`);
    process.exit(1);
  }

  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

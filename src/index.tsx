import puppeteer, { Browser, Page } from '@cloudflare/puppeteer';
import fxp from 'fast-xml-parser';
import pLimit from 'p-limit';
import { Fragment, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { reportHealthcheck } from './hc';
import { Profile, TextChunk, Tweet } from './tweet';
import tweetExtractJS from './tweet-extract.js.txt';
type ExtractResult = {
	profile: Profile;
	tweets: Tweet[];
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

const errMessage = (e: unknown): string => {
	if (e instanceof Error === false) {
		return `${e}`;
	}
	if (e.cause) {
		return `${e.message}: ${errMessage(e.cause)}`;
	}
	return e.message;
};

async function extractTweets(env: Env, b: Browser, username: string): Promise<ExtractResult> {
	let page: Page | null = null;
	try {
		console.log('extractTweets: starting', { username });
		page = await b.newPage();
		await page.setViewport({
			width: 1024,
			height: 768,
		});
		await page.goto(`https://x.com/${username}`);
		console.log('extractTweets: waiting for network idle', { username });
		await page.waitForNetworkIdle();

		console.log('extractTweets: setting up extraction code', { username });
		await page.evaluate(tweetExtractJS);

		console.log('extractTweets: waiting for UserDescription', { username });
		await page.waitForSelector('[data-testid=UserDescription]');
		const profile: Profile = (await page.evaluate('extractProfile()')) as any;

		console.log('extractTweets: waiting for tweets', { username });
		await page.waitForSelector('[data-testid=tweet]');
		await sleep(1_000);

		console.log('extractTweets: running extract tweets', { username });

		const tweets = await Promise.race([sleep(60_000), page.evaluate('extractTweets()') as Promise<Tweet[]>]);
		if (!tweets) {
			throw new Error(`timeout occurred while extracting tweets`);
		}
		console.log('extractTweets', { username, tweet_count: tweets.length });

		tweets.sort((a: Tweet, b: Tweet) => {
			return Date.parse(b.timestamp) - Date.parse(a.timestamp);
		});

		// console.log('extractTweets: setting up extraction', { username });
		// await page.addScriptTag({
		// 	content: tweetExtractJS,
		// });

		const maxUnwrap = pLimit(3);

		return {
			profile,
			tweets: await Promise.all(
				tweets.map(async (tweet): Promise<Tweet> => {
					return {
						...tweet,
						text_chunks: await Promise.all(
							tweet.text_chunks.map((chunk): Promise<TextChunk> => {
								if (chunk.type === 'link') {
									return maxUnwrap(async () => {
										const unwrappedHref = await unwrapLink(env, chunk.href);
										return {
											...chunk,
											href: unwrappedHref,
										};
									});
								}
								return Promise.resolve(chunk);
							})
						),
					};
				})
			),
		};
	} catch (e) {
		throw new Error(`failed to extract tweets for ${username}`, { cause: e });
	} finally {
		await page?.close();
	}
}

async function useBrowser<T = void>(env: Env, ctx: ExecutionContext, buf: (b: Browser) => Promise<T>): Promise<T> {
	let browser: Browser | null = null;
	try {
		browser = await puppeteer.launch(env.MAIN_BROWSER);
		return await buf(browser);
	} finally {
		ctx.waitUntil(browser?.close() ?? Promise.resolve());
	}
}

function tweetLinkExplode(link: string): [username: string, id: string] | [username: string, null] | [null, null] {
	const uri = URL.parse(link);
	if (!uri) {
		return [null, null];
	}
	switch (uri.hostname) {
		case 'x.com':
		case 'twitter.com':
			const [, username, statusWord, id] = uri.pathname.split('/');
			if (!username) {
				return [null, null];
			}
			if (typeof statusWord === 'undefined') {
				return [username, null];
			}
			if (statusWord === 'status') {
				return [username, id];
			}
			return [null, null];
	}
	return [null, null];
}

function tweetDataKey(username: string, id: string): string {
	return `tweet/u:${username.toLowerCase()}/id:${id}`;
}

function timelineDataKey(username: string): string {
	return `timeline:${username.toLowerCase()}`;
}

function profileDataKey(username: string): string {
	return `profile:${username.toLowerCase()}`;
}

type TweetPtr = ['repost' | 'post', string];

async function updateTweetsCache(env: Env, b: Browser, username: string): Promise<void> {
	try {
		const result = await extractTweets(env, b, username);
		const timeline = await Promise.all(
			result.tweets.map(async (tweet): Promise<TweetPtr> => {
				const [username, id] = tweetLinkExplode(tweet.link);
				if (!username || !id) {
					throw new Error(`failed to explode tweet link: ${tweet.link}`);
				}

				const isRepost = tweet.repost;
				delete tweet.repost;
				const key = tweetDataKey(username, id);
				return env.tweet_cache.put(key, JSON.stringify(tweet)).then(() => {
					return [isRepost ? 'repost' : 'post', key];
				});
			})
		);
		console.log('got tweets, saving to cache', { username });
		await Promise.all([
			env.tweet_cache.put(profileDataKey(username), JSON.stringify(result.profile)),
			env.tweet_cache.put(`tweets:${username}`, JSON.stringify(result)),
			env.tweet_cache.put(timelineDataKey(username), JSON.stringify(timeline)),
		]);
	} catch (e) {
		console.error(`failed to update tweets data for ${username}: ${errMessage(e)}`);
	}
}

function renderPlainText(chunks: TextChunk[]): string {
	let textContent = '';
	for (let c of chunks) {
		switch (c.type) {
			case 'text':
				textContent += c.content;
				break;
			case 'hashtag':
				textContent += c.hashtag;
				break;
			case 'link':
				textContent += c.href;
				break;
			case 'emoji':
				textContent += c.content;
				break;
			case 'mention':
				textContent += c.content;
				break;
		}
	}
	return textContent;
}

function renderHTML(chunks: TextChunk[]): ReactNode {
	const nodes: ReactNode[] = [];
	let currentParagraph: ReactNode[] = [];
	for (let i = 0; i < chunks.length; i++) {
		let chunk = chunks[i];
		switch (chunk.type) {
			case 'emoji':
				currentParagraph.push(<span key={`chunk-${i}`}>{chunk.content}</span>);
				break;
			case 'hashtag':
				currentParagraph.push(
					<a key={`chunk-${i}`} href={chunk.link} rel="noopener noreferrer nofollow" target="_blank">
						{chunk.hashtag}
					</a>
				);
				break;
			case 'link':
				currentParagraph.push(
					<a key={`chunk-${i}`} href={chunk.href} rel="noopener noreferrer nofollow" target="_blank">
						{chunk.href}
					</a>
				);
				break;
			case 'mention':
				const noAtUsername = chunk.user.slice(1);
				currentParagraph.push(
					<a key={`chunk-${i}`} href={`https://x.com/${noAtUsername}`} rel="noopener noreferrer nofollow" target="_blank">
						{chunk.user}
					</a>
				);
				break;
			case 'text':
				let lines = chunk.content.split('\n');
				while (lines.length) {
					const line = lines.shift();
					const last = lines.length === 0;
					currentParagraph.push(<Fragment key={`chunk-${i}`}>{line || <>&nbsp;</>}</Fragment>);
					if (!last) {
						nodes.push(<p>{currentParagraph}</p>);
						currentParagraph = [];
					}
				}
		}
	}
	if (currentParagraph.length > 0) {
		nodes.push(<p>{currentParagraph}</p>);
		// currentParagraph = [];
	}

	return (
		<>
			{nodes.map((n, i) => (
				<Fragment key={i}>{n}</Fragment>
			))}
		</>
	);
}

function renderAtomFeed(properUsername: string, tweets: ExtractResult, opts: { debug?: boolean }): Response {
	const b = new fxp.XMLBuilder({ ignoreAttributes: false, format: true, unpairedTags: ['link'] });

	const updated = tweets.tweets[0].timestamp;
	const entries: any[] = [];

	for (let t of tweets.tweets) {
		let titleParts = [];
		for (let c of t.text_chunks) {
			switch (c.type) {
				case 'text':
					let t = c.content.trim();
					if (t.length === 0) {
						continue;
					}
					t = t.replaceAll(/\s*\n+\s*/g, ' ');
					titleParts.push(t);
					break;
				case 'hashtag':
					titleParts.push(c.hashtag);
					break;
				case 'link':
					titleParts.push(c.href);
					break;
				case 'emoji':
					titleParts.push(c.content);
					break;
				case 'mention':
					titleParts.push(c.content);
					break;
			}
		}

		let mediaFooter = '';
		if (t.media.length > 0) {
			const top = t.media[0];
			if (top.type === 'photo') {
				mediaFooter += renderToString(
					<>
						<br />
						<img src={top.src} alt={top.alt} />
					</>
				);
			}
		}

		let xrssdebug = undefined;
		if (opts.debug) {
			xrssdebug = t;
		}

		const [username, id] = tweetLinkExplode(t.link);
		if (!username || !id) {
			throw new Error('invalid tweet link');
		}

		if (t.repost) {
			titleParts = [`🔁 @${properUsername} reposted:`, ...titleParts];
		}

		entries.push({
			id: {
				'#text': t.link,
			},
			title: {
				'#text': titleParts.join(' '),
			},
			updated: {
				'#text': t.timestamp,
			},
			link: {
				'@_href': `https://x-rss.nkcmr.dev/${username}/status/${id}`,
				'@_rel': 'alternate',
				'@_/': true,
			},
			content: {
				'@_type': 'html',
				'#text': renderToString(renderHTML(t.text_chunks)) + mediaFooter,
			},
			xrssdebug,
			author: {
				name: `${t.author.name} (@${username})`,
				uri: t.author.url,
			},
		});
	}

	const icon = tweets.profile.avatarImage
		? {
				'#text': tweets.profile.avatarImage,
		  }
		: undefined;

	const rawXML = b.build({
		'?xml': {
			'@_version': '1.0',
			'@_encoding': 'utf-8',
		},
		feed: {
			'@_xmlns': 'http://www.w3.org/2005/Atom',
			id: {
				'#text': `https://x.com/${properUsername}`,
			},
			icon,
			title: {
				'#text': `@${properUsername}`,
			},
			subtitle: {
				'@_type': 'html',
				'#text': renderToString(renderHTML(tweets.profile.description_chunks)),
			},
			link: [
				{
					'@_href': `https://x-rss.nkcmr.dev/${properUsername}.rss`,
					'@_rel': 'self',
					'@_/': true,
				},
				{
					'@_href': `https://x.com/${properUsername}`,
					'@_rel': 'alternate',
					'@_/': true,
				},
			],
			updated: {
				'#text': updated,
			},
			entry: entries,
		},
	});

	return new Response(rawXML, {
		headers: {
			'Content-Type': 'application/atom+xml',
		},
	});
}

function renderJSONFeed(properUsername: string, tweets: ExtractResult, { debug }: { debug?: boolean }): Response {
	const jsonFeed = {
		version: 'https://jsonfeed.org/version/1.1',
		title: `@${properUsername}`,
		home_page_url: `https://x.com/${properUsername}`,
		feed_url: `https://x-rss.nkcmr.dev/${properUsername}.json`,
		description: renderPlainText(tweets.profile.description_chunks),
		items: [] as any[],
	};

	for (let t of tweets.tweets) {
		if (t.repost) {
			continue;
		}
		let textContent = renderPlainText(t.text_chunks);
		let image: string | undefined;

		if (t.media.length > 0) {
			const [top] = t.media;
			if (top.type === 'photo') {
				image = top.src;
			} else if (top.type === 'video' && top.poster) {
				image = top.poster;
			}
		}

		const debugData = debug ? { tweets: t } : undefined;

		jsonFeed.items.push({
			id: t.link,
			url: t.link,
			date_published: t.timestamp,
			// content_text: textContent,
			content_html: renderToString(renderHTML(t.text_chunks)),
			_x_rss_debug: debugData,
			image: image,
		});
	}
	return new Response(JSON.stringify(jsonFeed, null, 2), {
		headers: {
			'Content-Type': 'application/feed+json',
		},
	});
}

function respondHTML(body: BodyInit) {
	return new Response(body, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
		},
	});
}

async function sha256(message: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

async function linkUnwrapResultData(link: string): Promise<string> {
	return `link-unwrap/hash:${await sha256('salt:2e360ca8-cb6b-455e-9168-d45c23a5d8be' + link)}`;
}

async function unwrapLink(env: Env, link: string): Promise<string> {
	const key = await linkUnwrapResultData(link);
	const savedValue = await env.tweet_cache.get(key, 'text');
	if (savedValue) {
		return atob(savedValue);
	}
	type LinkHop =
		| {
				seq: number;
				location: { original: string };
				status_code?: number;
				final: false;
		  }
		| {
				seq: number;
				location: { original: string; cleaned?: string; removed_params: string[] };
				status_code?: number;
				error?: string;
				final: true;
		  };
	interface LinkUnwrapAPI {
		follow(link: string): Promise<LinkHop[]>;
	}
	const hops = await (env.LINK_UNWRAP as Fetcher & LinkUnwrapAPI).follow(btoa(link));
	for (let h of hops.reverse()) {
		if (!h.final) {
			continue;
		}
		const final = h.location.cleaned ?? h.location.original;
		await env.tweet_cache.put(key, btoa(final), {
			expirationTtl: 1209600, // 2 weeks
		});
		console.log('unwrapLink', { original: link, final, key });
		return final;
	}
	throw new Error(`unable to determine "final" hop`);
}

const allowedUsernames = ['NWSNewYorkNY', 'NWSAnchorage', 'NWSMelbourne'];

const renderers: Record<string, typeof renderJSONFeed> = {
	json: renderJSONFeed,
	rss: renderAtomFeed,
};

function singleflight<R, A extends unknown[]>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	let activePromise: Promise<R> | null = null;
	return (...args: A) => {
		if (activePromise) {
			console.log('prevented double execution');
			return activePromise;
		}
		activePromise = fn(...args).finally(() => {
			activePromise = null;
		});
		return activePromise;
	};
}

const refreshAllProfiles = singleflight(async (env: Env, ctx: ExecutionContext): Promise<void> => {
	await useBrowser(env, ctx, async (b) => {
		const sem = pLimit(5);
		await reportHealthcheck(env, ctx, env.HEALTHCHECK_ID, async () => {
			await Promise.all(allowedUsernames.map((username) => sem(() => updateTweetsCache(env, b, username))));
		});
	});
	console.log('refreshAllProfiles: done');
});

export default {
	async scheduled(ctrl, env, ctx) {
		ctx.waitUntil(refreshAllProfiles(env, ctx));
	},
	async fetch(request, env, ctx): Promise<Response> {
		const baseu = new URL(request.url);

		if (baseu.pathname === '/bcdbe3d8-d9df-4885-a896-13d966a5a936') {
			ctx.waitUntil(refreshAllProfiles(env, ctx));
			return Response.json({ ok: true });
		}

		const extension = baseu.pathname.split('.').pop();
		const renderer = renderers[extension ?? 'never'];
		if (baseu.pathname.charAt(0) === '/' && typeof renderer === 'function') {
			const username = baseu.pathname.slice(1).slice(0, -(extension!.length + 1));
			const allowedUsernameIdx = allowedUsernames.map((au) => au.toLowerCase()).indexOf(username.toLowerCase());
			if (allowedUsernameIdx >= 0) {
				const debug = baseu.searchParams.has('debug');
				const properUsername = allowedUsernames[allowedUsernameIdx];
				const [timeline, profile] = await Promise.all([
					env.tweet_cache.get<TweetPtr[]>(timelineDataKey(properUsername), 'json'),
					env.tweet_cache.get<Profile>(profileDataKey(properUsername), 'json'),
				]);
				if (timeline && profile) {
					const tweets = await Promise.all(
						timeline.map(async (ptr): Promise<Tweet> => {
							const [ptrType, ptrValue] = ptr;
							const repost = ptrType === 'repost';
							const tweet = await env.tweet_cache.get<Omit<Tweet, 'repost'>>(ptrValue, 'json');
							if (!tweet) {
								throw new Error(`broken tweet pointer`);
							}
							return {
								...tweet,
								repost,
							} as Tweet;
						})
					);
					return renderer(
						properUsername,
						{
							profile,
							tweets,
						},
						{ debug }
					);
				}
				const cacheKey = `tweets:${properUsername}`;
				let tweets: ExtractResult | null = await env.tweet_cache.get(cacheKey, 'json');
				if (!tweets) {
					return Response.json({ error: 'no tweets available' }, { status: 503 });
				}

				return renderer(properUsername, tweets, { debug });
			}
		}

		if (/^\/[a-z0-9_]+\/status\/[0-9]+$/i.test(baseu.pathname)) {
			const [, username, , tweetID] = baseu.pathname.split('/');
			const t = await env.tweet_cache.get<Omit<Tweet, 'repost'>>(tweetDataKey(username.toLowerCase(), tweetID), 'json');
			if (!t) {
				return new Response('unknown tweet', { status: 404 });
			}
			const datetimefmt = Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
			return respondHTML(
				'<!DOCTYPE html>\n' +
					renderToString(
						<html lang="en">
							<head>
								<meta charSet="utf-8" />
								<meta name="viewport" content="width=device-width, initial-scale=1" />
								<link
									rel="stylesheet"
									href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css"
									referrerPolicy="no-referrer"
								/>
							</head>
							<body>
								<div style={{ width: '640px' }} className="container mx-auto p-8">
									<article>
										<div>
											<a href={t.author.url}>
												<img src={t.author.img} />
												{t.author.name}
											</a>
										</div>
										<br />
										<hr />
										<br />
										<time dateTime={t.timestamp}>{datetimefmt.format(Date.parse(t.timestamp))} (UTC)</time>
										<br />
										{renderHTML(t.text_chunks)}
										<br />
										{t.media.map((tm, i) => (
											<div key={i}>
												{tm.type === 'photo' && <img src={tm.src} alt={tm.alt} title={tm.alt} />}
												{tm.type === 'video' && (
													<>
														<video src={tm.src} poster={tm.poster} loop={tm.gif} autoPlay={tm.gif} muted={tm.gif} />
													</>
												)}
											</div>
										))}
									</article>
								</div>
							</body>
						</html>
					)
			);
		}

		return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
	},
} satisfies ExportedHandler<Env>;

import puppeteer, { Browser, Page } from '@cloudflare/puppeteer';
import pLimit from 'p-limit';
import { Fragment, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { reportHealthcheck } from './hc';
import tweetExtractJS from './tweet-extract.js.txt';
type ExtractResult = {
	profile: Profile;
	tweets: Tweet[];
};

type Tweet = {
	timestamp: string; // rfc3339
	text_chunks: TextChunk[];
	repost?: boolean;
	media: (
		| {
				type: 'photo';
				src: string;
				alt: string;
		  }
		| {
				type: 'video';
				src: string;
				poster: string;
				gif: boolean;
		  }
	)[];
	link: string;
};

type Profile = {
	description_chunks: TextChunk[];
};

type TextChunk = ChunkPlainText | ChunkMention | ChunkHashtag | ChunkLink | ChunkEmoji;

type ChunkPlainText = {
	type: 'text';
	content: string;
};

type ChunkMention = {
	type: 'mention';
	user: `@${string}`;
	content: string;
};

type ChunkHashtag = {
	type: 'hashtag';
	hashtag: `#${string}`;
	link: string;
};

type ChunkLink = {
	type: 'link';
	href: string;
};

type ChunkEmoji = {
	type: 'emoji';
	content: string;
	description: string;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

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

		await page.waitForSelector('[data-testid=UserDescription]');
		const profile: Profile = (await page.evaluate('extractProfile()')) as any;

		await page.waitForSelector('[data-testid=tweet]');
		await sleep(1_000);

		await env.SCREENSHOTS.put(`${Date.now()}.png`, await page.screenshot());

		const tweets: any = await page.evaluate('extractTweets()');
		console.log('extractTweets', { tweet_count: tweets.length });

		tweets.sort((a: Tweet, b: Tweet) => {
			return Date.parse(b.timestamp) - Date.parse(a.timestamp);
		});

		// console.log('extractTweets: setting up extraction', { username });
		// await page.addScriptTag({
		// 	content: tweetExtractJS,
		// });

		return {
			profile,
			tweets: tweets,
		};
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

async function updateTweetsCache(env: Env, b: Browser, username: string): Promise<void> {
	const result = await extractTweets(env, b, username);
	console.log('got tweets, saving to cache', { username });
	await env.tweet_cache.put(`tweets:${username}`, JSON.stringify(result));
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

function renderHTML(chunks: TextChunk[]): string {
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
					<a key={`chunk-${i}`} href={chunk.link}>
						{chunk.hashtag}
					</a>
				);
				break;
			case 'link':
				currentParagraph.push(
					<a key={`chunk-${i}`} href={chunk.href}>
						{chunk.href}
					</a>
				);
				break;
			case 'mention':
				const noAtUsername = chunk.user.slice(1);
				currentParagraph.push(
					<a key={`chunk-${i}`} href={`https://x.com/${noAtUsername}`}>
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

	return renderToString(
		<>
			{nodes.map((n, i) => (
				<Fragment key={i}>{n}</Fragment>
			))}
		</>
	);
}

const allowedUsernames = ['NWSNewYorkNY', 'NWSAnchorage', 'NWSMelbourne'];

export default {
	async scheduled(ctrl, env, ctx) {
		ctx.waitUntil(
			useBrowser(env, ctx, async (b) => {
				const sem = pLimit(2);
				await reportHealthcheck(env, ctx, env.HEALTHCHECK_ID, async () => {
					await Promise.all(allowedUsernames.map((username) => sem(() => updateTweetsCache(env, b, username))));
				});
			})
		);
	},
	async fetch(request, env, ctx): Promise<Response> {
		const baseu = new URL(request.url);

		if (baseu.pathname === '/__cf.json') {
			return new Response(
				JSON.stringify(
					{
						...request.cf,
						headers: [...request.headers.entries()],
					},
					null,
					2
				),
				{
					headers: {
						'Content-Type': 'application/json',
					},
				}
			);
		}
		if (baseu.pathname.charAt(0) === '/' && baseu.pathname.endsWith('.json')) {
			const username = baseu.pathname.slice(1).slice(0, -5);
			const allowedUsernameIdx = allowedUsernames.map((au) => au.toLowerCase()).indexOf(username.toLowerCase());
			if (allowedUsernameIdx >= 0) {
				const properUsername = allowedUsernames[allowedUsernameIdx];
				const cacheKey = `tweets:${properUsername}`;
				let tweets: ExtractResult | null = await env.tweet_cache.get(cacheKey, 'json');

				const debug = baseu.searchParams.has('debug');
				if (baseu.searchParams.has('fresh') && request.headers.get('cf-connecting-ip') === '100.38.153.109') {
					tweets = await useBrowser(env, ctx, (b) => {
						return extractTweets(env, b, properUsername);
					});
				}
				if (!tweets) {
					return Response.json({ error: 'no tweets available' }, { status: 503 });
				}

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

					// @ts-ignore
					if (t.photos) {
						// @ts-ignore
						t.media = t.photos.map((p) => ({ type: 'photo', ...p }));
						// @ts-ignore
						delete t.photos;
					}

					// can delete in a bit
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
						content_html: renderHTML(t.text_chunks),
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
		}

		return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
	},
} satisfies ExportedHandler<Env>;

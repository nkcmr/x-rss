/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="es2023" />
import type { ChunkHashtag, ChunkMention, ChunkPlainText, Profile, TextChunk, Tweet } from './tweet';

function getStructure(el: Node): string {
	let c = el;
	let struct: string[] = [];
	while (c) {
		struct.push(c.nodeName);
		if (c.childNodes.length !== 1) {
			break;
		}
		c = c.childNodes[0];
	}
	return struct.join('::');
}

function nearestParentWhere(el: Node, where: (el: Node) => boolean) {
	let c = el.parentNode;
	while (c && !where(c)) {
		c = c.parentNode;
	}
	return c;
}

function whereNodeName(is: string): (el: Node) => boolean {
	return (el) => {
		return el.nodeName === is;
	};
}

function extractProfile(): Profile {
	const descriptionEl = document.querySelector('[data-testid=UserDescription]');
	if (!descriptionEl) {
		throw new Error(`unable to find user description`);
	}
	const descriptionChunks = extractTextChunks(descriptionEl);

	const ldJsonEl = document.querySelector('script[type="application/ld+json"]');
	if (!ldJsonEl) {
		throw new Error(`no ld json in profile`);
	}
	const ld = JSON.parse(ldJsonEl.textContent ?? '');

	return {
		name: ld.author.givenName,
		username: ld.author.additionalName,
		homepage: ld.relatedLink.find((l: string) => !l.includes('/t.co/')),
		avatarImage: ld.author.image.thumbnailUrl,
		description_chunks: descriptionChunks,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function extractTextChunks(el: Node): TextChunk[] {
	const chunks: TextChunk[] = [];
	for (let ttcel of el.childNodes) {
		const struct = getStructure(ttcel);
		switch (struct) {
			case 'SPAN::#text':
				if (ttcel.textContent) {
					chunks.push({ type: 'text', content: ttcel.textContent } satisfies ChunkPlainText);
				}
				break;
			case 'DIV::SPAN::A::#text':
				if ((ttcel.textContent ?? '').trim().startsWith('@')) {
					chunks.push({ type: 'mention', user: (ttcel.textContent ?? '').trim(), content: ttcel.textContent! } satisfies ChunkMention);
				} else {
					throw new Error(`${struct} was not a mention as expected`);
				}
				break;
			case 'SPAN::A::#text':
				const anchorEl = ttcel.childNodes[0] as HTMLAnchorElement;
				if (anchorEl.textContent?.charAt(0) === '#') {
					chunks.push({ type: 'hashtag', hashtag: anchorEl.textContent, link: anchorEl.href } satisfies ChunkHashtag);
				} else {
					throw new Error('SPAN::A::#text was not a hashtag like expected');
				}
				break;
			case 'A':
				let linkEl = ttcel as HTMLAnchorElement;
				chunks.push({ type: 'link', href: linkEl.href });
				break;
			case 'IMG':
				let imgEl = ttcel as HTMLImageElement;
				if (imgEl.src.includes('/emoji/')) {
					chunks.push({ type: 'emoji', content: imgEl.alt, description: imgEl.title });
				} else {
					throw new Error(`${struct} was not an emoji as expected`);
				}
				break;
			default:
				throw new Error(`unexpected tweet text structure: ${struct}`);
		}
	}
	return chunks;
}

async function extractTweet(tweetEl: Element): Promise<Tweet | null> {
	let repost = false;
	const socialContext = tweetEl.querySelector('[data-testid=socialContext]');
	if (socialContext) {
		if (socialContext.textContent?.toLowerCase().endsWith(' reposted')) {
			repost = true;
		} else if (socialContext.textContent?.toLowerCase().includes('pinned')) {
			return null;
		}
	}

	(tweetEl as any).scrollIntoView();
	await sleep(500);
	const tweetTextEl = tweetEl.querySelector('[data-testid=tweetText]');
	if (!tweetTextEl) {
		throw new Error('no tweet text found');
	}
	const textChunks = extractTextChunks(tweetTextEl);

	const authorImgEl = tweetEl.querySelector('[data-testid=Tweet-User-Avatar] img');
	if (!authorImgEl) {
		throw new Error('missing user avatar element');
	}

	const authorUserNameLink = tweetEl.querySelector('[data-testid=User-Name] a') as HTMLAnchorElement;
	if (!authorUserNameLink) {
		throw new Error('missing user name link');
	}
	const authorUrl = authorUserNameLink.href;
	const authorName = authorUserNameLink.textContent ?? '???';

	const time = tweetEl.querySelector('time');
	if (!time) {
		throw new Error(`missing <time> element in tweet`);
	}

	const tweetAnchor = nearestParentWhere(time, whereNodeName('A')) as HTMLAnchorElement | null;
	if (!tweetAnchor) {
		throw new Error(`could not find tweet link as parent of <time>`);
	}

	const media: Array<Tweet['media']['0']> = [];
	const tweetPhoto = tweetEl.querySelector('[data-testid=tweetPhoto]');
	if (tweetPhoto) {
		const img = tweetPhoto.querySelector('img');
		const video = tweetPhoto.querySelector('video');
		if (img) {
			media.push({
				type: 'photo',
				src: img.src,
				alt: img.alt,
			});
		} else if (video) {
			const isGif = [...tweetPhoto.querySelectorAll('span')].findIndex((el) => (el.textContent ?? '').toLowerCase() === 'gif') >= 0;
			media.push({
				type: 'video',
				src: video.src,
				poster: video.poster,
				gif: isGif,
			});
		}
	}

	return {
		author: {
			img: (authorImgEl as HTMLImageElement).src,
			name: authorName,
			url: authorUrl,
		},
		link: tweetAnchor.href,
		timestamp: time.dateTime,
		text_chunks: textChunks,
		repost,
		media: media,
	};
}

async function extractTweets(): Promise<Tweet[]> {
	const tweets: Tweet[] = [];
	const start = Date.now();

	let tweetEl = document.querySelector('[data-testid=tweet]');
	while (tweetEl && tweets.length < 15) {
		const now = Date.now();
		const elapsed = now - start;
		if (elapsed > 60_000) {
			throw new Error('timeout!');
		}
		// @ts-ignore
		tweetEl.dataset.extracted = 'true';
		const tweet = await extractTweet(tweetEl);
		if (tweet) {
			tweets.push(tweet);
		}
		tweetEl = document.querySelector(`[data-testid=tweet]:not([data-extracted])`);
	}

	return tweets;
}

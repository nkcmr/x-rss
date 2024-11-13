export type Tweet = {
	author: {
		name: string;
		url: string;
		img: string;
	};
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

export type Profile = {
	name: string;
	username: string;
	homepage?: string;
	avatarImage: string;
	description_chunks: TextChunk[];
};

export type TextChunk = ChunkPlainText | ChunkMention | ChunkHashtag | ChunkLink | ChunkEmoji;

export type ChunkPlainText = {
	type: 'text';
	content: string;
};

export type ChunkMention = {
	type: 'mention';
	user: string;
	content: string;
};

export type ChunkHashtag = {
	type: 'hashtag';
	hashtag: string;
	link: string;
};

export type ChunkLink = {
	type: 'link';
	href: string;
};

export type ChunkEmoji = {
	type: 'emoji';
	content: string;
	description: string;
};
